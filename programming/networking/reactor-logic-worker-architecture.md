---
title: "Reactor 游戏服务器：IO 线程、Logic Worker 与场景分片"
created: 2026-10-18T10:11:00+08:00
updated: 2026-10-18T10:11:00+08:00
tags: [游戏服务器, Reactor, Logic Worker, SceneSvr, 线程模型]
status: review
---

# Reactor 游戏服务器：IO 线程、Logic Worker 与场景分片

讨论 RCU 在游戏服务器里的用途，最后反而引出了一个更值得先解决的问题：**如果架构能明确规定谁拥有数据、谁负责写入，是否根本不需要 RCU？**

以 Main-Sub Reactor + 单逻辑线程为起点，答案通常是肯定的。再往下，需要理清 IO Thread、Logic Worker、GameSvr、SceneSvr 的关系。

## Main-Sub Reactor 与游戏逻辑线程

这里讨论的是以下模型：

```text
                 Main Reactor
                  accept()
                     │
           ┌─────────┼─────────┐
           ▼         ▼         ▼
       IO Thread1 IO Thread2 IO Thread3
       Sub Reactor 各自管理连接的事件循环
           │         │         │
           └─────────┼─────────┘
                     ▼
                MPSC Queue
                     ▼
                Logic Worker
            Player / Scene / Battle
```

Main Reactor 接受连接并分配给某个 Sub Reactor。每个 Sub Reactor 有自己的 IO 线程、事件循环和负责的 socket，承担收包、解包、校验与基本预处理。随后把业务消息投递到逻辑线程队列。

需要区分两种实现：如果每个 IO 工作线程都运行自己的事件循环，可以称为经典的 Main-Sub Reactor；如果只有一个 Reactor 监听事件，再把具体读写任务发给普通线程池，它属于另一种线程组织方式，不宜简单混称。

网络事件处理模式与逻辑线程数不是同一个概念：**Reactor 并不规定游戏必须有几个 Logic Worker。**

## IO Thread 与 Logic Worker 的所有权

```text
socket / recv buffer / send queue
            │
            ▼
       对应 IO Thread
            │ 业务消息
            ▼
         Message Queue
            │
            ▼
         Logic Worker
            │
            └── Player / Scene / Battle
```

- 一条连接原则上固定到其 IO 线程，避免多个 IO 线程同时操作连接内部可变状态。
- 玩家业务状态由所属逻辑 Worker 更新，IO 线程不直接修改 `Player`、`Scene`。
- Logic 处理完成后，把待发送消息投递给对应 IO 线程，由后者执行 `send()` 和写缓冲操作。

IO → Logic 是多个 IO 生产者、一个 Logic 消费者时，适合 MPSC 队列。Logic → 某个 IO 的队列是否是 SPSC，取决于其他线程是否也能向该队列写入。

跨线程队列仍需要同步，Session 的关闭与生命周期也仍需谨慎处理。**逻辑对象不加锁，不等于整个服务端没有任何原子操作和同步。**

## 单 Logic Worker 的 GameSvr

```text
GameSvr
 ├── Reactor / IO Threads
 └── Logic Worker 1
       ├── Players
       ├── Scenes
       ├── Battle
       └── Timers
```

此时 GameSvr 的所有可变业务状态由一个逻辑线程拥有。队列消息在逻辑线程中串行处理，基本不需要为 Player、Scene 数据结构引入 mutex 或 RCU。

这里的 `Logic Worker` 可以理解为：**一个执行线程 + 一个消息队列 + 一个工作循环**。Worker 一词并不天然等于一个 OS 线程，只是在这套设计中采用一一对应。

一个进程一个 Logic Worker 是简单有效的起点，但不意味着整个游戏只有一个 Worker：可通过多个 GameSvr 进程并行扩展。

## 逻辑线程多还是少：看 Tick 预算

不能仅根据在线人数确定线程数。更直接的依据是：

- 单 Tick 的实际计算耗时与 P95/P99；
- 业务消息排队时延和队列长度；
- 玩家、怪物、碰撞、AI 等实际计算量；
- 是否有阻塞操作（同步 DB、HTTP、文件 IO）卡住逻辑循环。

例如 20 Tick/s 的周期是 50ms。50ms 是**整个 Tick 周期**而非推荐把计算耗尽的目标，应当留出调度抖动和尾部延迟余量。

可以从一个逻辑线程开始；只有达到明显瓶颈时，再增加 Worker 或服务实例。

## 多个 Logic Worker：按 Scene 而不是 Player 随机分配

如果 GameSvr 内有很多独立场景，可以让多个逻辑线程分别独占一些 Scene：

```text
GameSvr
 ├── Worker 1 → Scene A、B
 ├── Worker 2 → Scene C、D
 └── Worker 3 → Scene E、F
```

关键原则是 **Single-Writer（单写者）**：同一份 Scene 可变状态在一个时刻只有一个权威 Worker 负责修改。

玩家进入 Scene C，应该按场景路由到 Worker 2，而不是给玩家随机挑选一个 Worker：

```text
玩家移动包 → IO Thread → 查 SceneId 归属
                                 │
                                 ▼
                              Worker 2
                                 │
                                 ▼
                              Scene C
```

同一个 Worker 可以负责多个 Scene。同一个 Scene 也未必始终绑定同一个 Worker：如果支持迁移，需要明确切换时机和迁移协议。但第一版通常适合**创建时分配、存活期间固定**。

这样不同 Scene 并行执行，同一 Scene 内依然保持串行修改。不必把每个 `Player`、`Monster` 都变成可任意跨线程修改的共享对象。

## 单独拆出 SceneSvr：多个服务实例、多个 Worker

进一步扩展可以把场景计算从 GameSvr 拆出：

```text
Gateway
    │
 GameSvr
    │ 场景路由 / 业务协调
    ├── SceneSvr 1
    │     ├── Worker 1 → Scene A、B
    │     └── Worker 2 → Scene C
    └── SceneSvr 2
          ├── Worker 1 → Scene D
          └── Worker 2 → Scene E、F
```

这是 **多个 Scene 对多个 Worker，对多个 SceneSvr 实例** 的分片关系，而不是“每个玩家始终绑定同一个 Scene Worker”。

路由示意：

```cpp
struct SceneRoute {
    uint32_t sceneSvrId;
    uint32_t workerId;
    uint64_t version;
};
```

`version` 是可选的设计示例，可用于识别迁移前后的过期路由；它不能单独保证迁移正确。

## Player 进入场景时谁负责什么？

需要明确不同状态的**权威归属**，例如：

| 数据 | 可能的权威写者 |
| --- | --- |
| 账号、角色长期进度、任务 | GameSvr 或专门业务服务 |
| 位置、怪物、碰撞、AOI | Scene Worker |
| 战斗状态 | Scene Worker 或 BattleSvr |
| 公会、聊天 | 相应业务服务 |

拆服后，玩家可能同时在 GameSvr 与 SceneSvr 上有不同的状态表示。关键不是“只能存在一个 Player 对象”，而是**同一个可变业务字段不能有多个无协调的权威写者**。

例如 SceneSvr 更新战斗血量、GameSvr 执行持久化，需要用明确的状态变更事件、版本、顺序或结算协议协调，而不是两边直接随意写同一字段。

## Scene 跨 Worker 迁移：为什么不简单？

假设 Worker 1 负责的 Scene A、B 都很繁忙，Worker 2 较空闲。把 Scene B 移过去，至少要解决：

1. 在安全点冻结或协调旧 Worker 对该 Scene 的处理；
2. 转移完整的场景状态及未完成任务语义；
3. 建立新 Worker 对 Scene 的唯一权威；
4. 切换带版本的路由，并处理旧 Worker 队列里的在途消息；
5. 恢复处理，避免丢消息、重复执行与乱序。

如果跨进程迁移，还涉及网络通信、失败恢复和状态一致性。**仅修改映射表不等于完成迁移。**

所以第一版建议按创建时负载分配，优先监控各 Worker 的 Tick 耗时、玩家量、队列延迟，再判断是否有必要做运行中的动态迁移。

## Draining：关闭旧 SceneSvr 之前的排空阶段

节点进入 Draining 表示准备停止承接**新增负载**，但可能继续处理已有玩家、在途请求和迁移操作：

```text
Running → Draining → Stopped
```

例如旧 SceneSvr 不再分配新场景，旧场景结算或迁移完成后再停止。不能简单理解为 Draining 之后拒绝所有消息，否则已有战斗的玩家指令也会被直接中断。

RCU 如果用于共享路由表，只能保证读线程访问的旧路由对象不会被过早释放；它**不能保证旧服务仍然能够处理消息**。服务迁移还需 Draining、在途消息处理、重试或转移协议。

## 这种架构还需要 RCU 吗？

对于被单一 Logic Worker 独占的 Player、Scene、Battle 状态，通常**不需要**。这是线程所有权带来的简化，而不是 Reactor 天然替代 RCU。

还有可能需要同步的边界：

- IO → Logic、Logic → IO 消息队列；
- 跨 Worker 消息；
- Session 对象生命周期与关闭状态；
- 多线程直接访问的服务路由表、配置快照和全局索引。

这些场景可先评估线程独占、消息传递、简单锁或不可变快照，读路径性能确实成为瓶颈后再评估 RCU。

## 当前推荐的演进路径

```text
Main-Sub Reactor + 1 Logic Worker
             ↓ 逻辑负载增加
按 Scene/Room 归属划分多个 Worker
             ↓ 跨进程扩展需求增加
多个 GameSvr / SceneSvr 实例
             ↓ 负载不均衡确实影响体验
引入 Scene 迁移与更复杂的协调协议
```

这是一条架构推导路径，不是已经在某个实际项目里完成的实现或压测结果。

相关：[从 Reactor 到 Proactor](reactor-and-proactor.md) · [Reactor 与 Proactor 的工程选择](reactor-vs-proactor-in-practice.md) · [深入浅出 RCU](rcu-read-copy-update.md)
