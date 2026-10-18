---
title: "深入浅出 RCU：读取、更新与安全回收"
created: 2026-10-18T10:11:00+08:00
updated: 2026-10-18T10:11:00+08:00
tags: [C++, 并发, RCU, 内存回收, 游戏服务器]
status: review
---

# 深入浅出 RCU：读取、更新与安全回收

RCU（Read-Copy-Update，读取-复制-更新）常被概括为“读线程几乎不用加锁”。这句话容易让人误以为 RCU 只是更快的读写锁。真正需要理解的问题是：**写线程替换了数据之后，如何确定旧数据可以安全释放？**

## 为什么会想到 RCU？

以游戏服的全局配置为例：多个线程频繁读取，后台偶尔更新配置。

```cpp
struct GameConfig {
    int maxLevel;
    float dropRate;
};
```

用普通互斥锁保护，读读之间也要互斥；用读写锁，多个读者可以并发持有共享锁，但读侧仍需获取和释放锁。当读频率非常高、写入很少时，可以考虑另一种办法：**不在已发布的旧对象上原地写入，而是先构造新版本，再一次性发布。**

```text
读线程 1 ───────→ 配置 A（旧）
读线程 2 ───────→ 配置 A（旧）
写线程   ───────→ 构建配置 B
                        ↓
                   发布 B
                        ↓
新读线程 ───────→ 配置 B
旧读线程 ───────→ 配置 A（尚未回收）
```

这个过程有两个不同的时间点：**新配置发布生效**，与**旧配置允许回收**。不能把它们合并。

## Read、Copy、Update 分别做什么？

在不可变配置快照的例子里：

1. Read：读者在受保护的读侧临界区中读取当前版本。
2. Copy：写者构造新配置（这里复制旧配置是方便理解的策略，不意味着所有 RCU 更新都复制整个对象）。
3. Update：写者原子地发布新指针，使后续读者能够看到新版本。
4. Reclaim：等确认可能访问旧版本的读者结束后，再回收旧对象。

RCU 可用于链表节点等数据结构的局部替换与删除，并非必须整表复制。

## 原子指针为什么还不够？

假设有：

```cpp
std::atomic<GameConfig*> current;
```

发布与读取可以使用 Acquire/Release：

```cpp
// 写者：对象已构造完成
current.store(next, std::memory_order_release);

// 读者
GameConfig* p = current.load(std::memory_order_acquire);
```

读者如果读到了与 Release 对应的发布结果，Acquire/Release 可以保证看到发布前完成的初始化。但是，**它不保证 p 指向的对象还活着**。

```cpp
GameConfig* old = current.exchange(next);
delete old; // 危险：读者可能仍持有 old
```

因此，原子发布只是一部分。读侧保护协议和延迟回收协议缺一不可。上面的原始指针片段不是完整、可安全运行的 RCU 实现。

## Grace Period（宽限期）

Grace Period（GP）指的是：从某个更新后的观察点出发，等待所有**可能仍持有被替换旧对象引用**的相关读侧临界区结束。

```text
时间       T0              T1             T2
读者 A     [------读取旧版本------]
写者                       发布新版本 ---- 等待 GP ---- 回收旧版
读者 B                         [---读取新版本---]
```

写者不需要等后来不断加入的所有新读者退出；它关心的是可能使用旧对象的那些读者。不同 RCU 变体通过不同机制判断 GP 是否结束。

以 Linux 内核的典型 API 为例（以下是 API 使用顺序的示意，不是完整的并发写者实现）：

```c
rcu_read_lock();
struct config *p = rcu_dereference(current_config);
/* 在读侧临界区使用 p */
rcu_read_unlock();

/* 写侧：需要另行协调并发写者 */
rcu_assign_pointer(current_config, new_config);
synchronize_rcu();
/* 此后在满足对象引用约束时回收被摘除的旧配置 */
```

`synchronize_rcu()` 等待相应宽限期；也可以使用 `call_rcu()` 在宽限期后异步回调回收。不能把 `synchronize_rcu()` 简化理解为“所有线程同时完全停下”。

## RCU、COW、shared_ptr 有什么区别？

| 机制 | 主要解决的问题 | 代价或前提 |
| --- | --- | --- |
| 互斥锁 | 串行化访问 | 读者之间也互斥 |
| 读写锁 | 多读者共享，写者独占 | 读侧仍有锁操作 |
| COW（Copy-on-Write） | 修改时创建或复制新版本 | **不直接解决**旧对象何时释放 |
| 原子 shared_ptr 快照 | 发布新版本并通过引用计数延长寿命 | 读侧可能有原子引用计数开销 |
| RCU | 低开销读取和延迟安全回收 | 需正确处理读侧临界区与 GP |

COW 和 RCU 可以组合；但 COW 不是 RCU 的替代回收协议。RCU 也不表示所有写入都无锁。

对于 C++14，一个容易实现的替代方案是不可变 `std::shared_ptr<const GameConfig>` 快照，使用 `std::atomic_load` / `std::atomic_store` 自由函数发布和读取。注意必须对同一共享指针保持一致的同步访问，且这种实现不保证内部无锁。

```cpp
#include <memory>
#include <atomic>

struct GameConfig {
    int maxLevel = 100;
};

class ConfigManager {
public:
    ConfigManager()
        : current_(std::make_shared<const GameConfig>()) {}

    std::shared_ptr<const GameConfig> Get() const {
        return std::atomic_load(&current_);
    }

    void Update(const GameConfig& value) {
        std::shared_ptr<const GameConfig> next =
            std::make_shared<const GameConfig>(value);
        std::atomic_store(&current_, next);
    }

private:
    std::shared_ptr<const GameConfig> current_;
};
```

读者持有旧快照期间，即使发布新快照，旧对象也不会被提前释放。**这属于引用计数快照方案，而非经典 GP 型 RCU**。

## 游戏服务器里哪些地方值得考虑？

需要区分“确有公开证据使用 RCU 的工程”和“在游戏服设计中可能适用的场景”。目前这里没有直接核实到具体商业游戏逻辑服使用 RCU 的案例，不能将可能性写成事实。

公开可核实的工程包括 Linux 内核网络等子系统的 RCU 使用、Meta Folly 的用户态 RCU，以及 liburcu 的用户态实现。它们证明机制可工程化使用，但不是某款游戏已部署的证据。

**游戏服中可能适用：**

- 多 IO 线程共享且低频更新的网关路由/服务节点表；
- 多线程直接查询的 Session 索引及对象延迟回收；
- 多线程读取的不可变配置快照；
- 极少更新但频繁查询的处理器注册表。

**通常不推荐：**

- 单个逻辑线程独占的 Player、Scene、Battle 状态；
- 持续写入的 HP、位置与 Buff 数据；
- 原本可以通过消息队列避免的跨线程共享。

尤其要注意：RCU 只保证被保护对象的内存访问安全。路由到已经停机的服务器、Session 的关闭状态、socket 所有权、业务事务一致性，都需要其他协议处理。

如果服务器采用 **Reactor IO 线程 + 消息队列 + 单写者 Logic Worker**，大部分游戏对象就没有跨线程共享写入问题，通常无须 RCU。先做好线程归属，再以基准测试决定是否在高频共享读路径引入 RCU。

## 进一步研究

- Quiescent State Based Reclamation（QSBR）：线程如何报告静止状态；
- Epoch-Based Reclamation：基于纪元的延迟回收；
- Hazard Pointer：读者如何显式保护正在访问的对象。

这些机制和 RCU 的回收目标相关，但不应全部混为同一算法。

## 参考资料

- [Linux Kernel — What is RCU?](https://www.kernel.org/doc/html/latest/RCU/whatisRCU.html)
- [Linux Kernel — RCU list operations](https://www.kernel.org/doc/html/latest/RCU/listRCU.html)
- [Folly — RCU](https://github.com/facebook/folly/tree/main/folly/synchronization)
- [Userspace RCU（liburcu）](https://liburcu.org/)

相关：[C++11/14 互斥锁与读写锁](../cpp/mutex-and-reader-writer-locks.md) · [Reactor 游戏服务器的线程模型与架构演进](reactor-logic-worker-architecture.md)
