---
title: "Reactor 和 Proactor，在实际开发中应该如何选择？"
created: 2026-10-15
updated: 2026-10-15
tags: [C++, 网络编程, Reactor, Proactor, 游戏服务器]
status: review
---

# Reactor 和 Proactor，在实际开发中应该如何选择？

弄清楚 Reactor 和 Proactor 的区别后，又有了一个更实际的问题：**既然两种模型都能处理大量连接，在真正开发服务器时，它们有什么差异？**

特别是游戏服务器。如果我已经有一套基于 `epoll` 的 Reactor 网络层，有没有必要换成 Proactor？

先说目前的认识：**没有必要仅仅因为 Proactor 听起来更新，就重写成熟的 Reactor 网络层。** 选型更应该看部署平台、网络负载、线程模型和维护成本。

## IO 处理代码有什么区别？

还是以接收一个玩家的数据为例。

Reactor 中，框架或应用在收到可读事件之后主动读：

```cpp
void OnReadable(int fd) {
    // 示例省略完整的 EAGAIN、EINTR、关闭及错误处理
    char buffer[4096];
    ssize_t n = recv(fd, buffer, sizeof(buffer), 0);
    if (n > 0) {
        ProcessBytes(buffer, static_cast<size_t>(n));
    }
}
```

Proactor 风格下，应用先提交异步读操作，再处理完成结果：

```cpp
void Session::StartRead() {
    socket_.async_read_some(
        asio::buffer(buffer_),
        [this](const auto& ec, std::size_t n) {
            if (ec) {
                Close();
                return;
            }

            ProcessBytes(buffer_.data(), n);
            StartRead();
        }
    );
}
```

后一段同样是结构示意：真实项目里要解决 Session 生命周期、并发关闭、缓冲区有效性等问题，不能简单地认为捕获 `this` 就是安全做法。

从开发者的感受来说，区别主要在**谁负责推进 IO 操作**。

Reactor 下，可以直接在可读回调里决定本轮读多少次、什么时候停止、怎么处理 `EAGAIN`。Proactor 风格下，通常通过提交操作的时机、请求大小、取消机制以及下一次读取的安排来控制行为。

并不是 Proactor 无法控制读取策略，而是控制点从“执行 recv 的现场”转移到了“异步操作的提交和完成”。

## 线程模型会不同吗？

不一定。线程模型与 Reactor/Proactor 并不是一一绑定的。

我比较熟悉的一种游戏服务器结构是：

```text
IO 线程（epoll、recv、send）
             ↓
         消息队列
             ↓
      游戏逻辑线程
             ↓
         发送队列
             ↓
          IO 线程
```

一个 Session 可以固定由某个 IO 线程处理，游戏对象的修改则集中到逻辑线程。

换成 Asio 风格的网络接口后，这个结构依然成立：

```text
异步读完成回调
       ↓
协议解析、消息队列
       ↓
游戏逻辑线程
       ↓
发送队列
       ↓
提交异步写操作
```

也就是说，**换一种 IO API 不等于需要重新设计游戏逻辑线程模型。**

需要另外注意的是回调并发问题。如果多个线程都在执行 `io_context.run()`，同一个 Session 的不同完成回调可能由不同线程执行，甚至出现时间重叠。Asio 的 `strand` 可以让绑定到同一 Strand 的 Handler 不并发执行。

但 Strand 也不是 Proactor 的必需组成部分：固定线程归属、消息队列、互斥锁等方式同样可以管理共享状态；而且绕过 Strand 直接访问共享数据，仍然可能产生数据竞争。

## Proactor 的性能会更好吗？

不能只凭模式名称判断。

比如比较：

- Linux 下自己实现的 `epoll + recv/send`；
- Linux 下基于 `epoll` 的 Boost.Asio 异步 Socket。

两者底层可能经历相近的就绪通知和非阻塞读写路径。Asio 多了操作状态和完成回调的组织，但也可能减少大量应用层手写调度代码。因此性能差异需要具体测量，不能预先认定谁更快。

如果比较 `epoll` 与 `io_uring`，情况又不同。`io_uring` 可以批量提交操作，通过完成队列取回结果，在部分工作负载中还能减少系统调用开销。但它不保证每种网络负载下都比 `epoll` 快。

对游戏服务器而言，网络层未必是唯一的瓶颈。高频小包、逻辑线程忙碌、消息队列争用、协议编解码、频繁分配内存，都可能影响吞吐和延迟。没有监控和基准测试时，单换 IO 模型可能解决不了实际问题。

因此真要比较，至少应明确：连接数、活跃连接比例、报文大小、发送频率、线程数、CPU 利用率，以及吞吐量与尾延迟（例如 P99）。不同指标可能得出不同结论。

## 不同平台如何选？

**Linux 上的 TCP 游戏服务器**：`epoll` Reactor 已经非常成熟。如果已有经过生产验证的实现，优先维护它。新项目也可以选择 Asio，让库来管理异步网络操作。

**Windows 服务器**：Overlapped I/O + IOCP 是值得优先考虑的成熟完成式 IO 方案。

**跨平台 C++ 项目**：Asio 的价值在于提供统一的异步操作接口，而不是简单声称它“比 Reactor 性能高”。Windows 可以利用对应的异步机制；在部分 Unix-like 平台上则可以通过 Reactor 支撑相同的接口。

**文件和网络混合的高吞吐 IO 场景**：可以研究 `io_uring`，尤其是操作批量提交和完成队列。但要评估内核版本、操作类型、部署兼容性及调试维护成本。

## 如果从零开发游戏服务器呢？

假设目标是 C++、Linux、TCP 长连接，游戏逻辑与网络 IO 分离，我大致会这样判断：

| 前提 | 倾向 |
| --- | --- |
| 已有成熟、稳定的 epoll 框架 | 继续使用，除非有明确痛点 |
| 新项目，希望少维护底层网络细节 | 评估 Asio |
| 需要 Windows / Linux 跨平台 | 优先评估 Asio 的统一接口 |
| 已确认 IO 提交或系统调用开销是瓶颈 | 对比测试 epoll 与 io_uring |
| 主要瓶颈在业务逻辑或跨线程队列 | 先解决对应瓶颈，不急着换 IO 模型 |

Asio 并不是 C++14 标准库的一部分，C++14 项目需要额外引入 Boost.Asio 或独立版 Asio。不过，这不影响选择它作为工程依赖。至于 `io_context`、Executor、Strand 的完整用法，以及 Session 的安全关闭和发送队列，这次还没有深入实践，暂时不展开成教程。

## 目前的结论

通过这次比较，我更倾向于把 Reactor 与 Proactor 当成**两种不同的异步 IO 编程组织方式**，而不是按性能或先进程度简单排名。

如果已经有适合业务的 Reactor，实现稳定、可观测、容易排查，没有因为模式名称而迁移的必要。如果是一个新项目，选择 Asio 可能节省底层网络封装的维护工作，但最终还要看团队熟悉程度和项目约束。

## 参考资料

以下资料于 2026-10-15 查阅，用于核对异步模型、IOCP 与 io_uring 机制。上述工程选型是基于机制和讨论场景的判断，**没有进行针对游戏服务器负载的实测**。

- [Boost.Asio — The Proactor Design Pattern](https://www.boost.org/doc/libs/latest/doc/html/boost_asio/overview/core/async.html)
- [Microsoft Learn — I/O Completion Ports](https://learn.microsoft.com/en-us/windows/win32/fileio/i-o-completion-ports)
- [Linux man-pages — io_uring(7)](https://man7.org/linux/man-pages/man7/io_uring.7.html)

前一篇：[从 Reactor 到 Proactor：两种 IO 模型的区别与联系](reactor-and-proactor.md)
