---
title: "从 Reactor 到 Proactor：两种 IO 模型的区别与联系"
created: 2026-10-15
updated: 2026-10-15
tags: [C++, 网络编程, Reactor, Proactor, epoll]
status: review
---

# 从 Reactor 到 Proactor：两种 IO 模型的区别与联系

之前接触网络编程，使用的主要是 Reactor 模型。对 Linux 下的非阻塞 Socket、`epoll` 和事件循环都比较熟悉。后来看到 Proactor，最先产生的疑问是：它和 Reactor 的区别究竟在哪里？是不是只是在 Reactor 上又封装了一层？

要弄清这个问题，我觉得直接从一次 TCP 读取开始比较容易理解。

## 从 Reactor 看起

在 Reactor 模型里，我们把 Socket 注册到事件多路复用器，等待它变成可读或可写。以 Linux 的 `epoll` 为例：

```text
客户端发送数据
    ↓
内核 Socket 接收缓冲区出现数据
    ↓
epoll_wait 返回 EPOLLIN
    ↓
应用调用 recv()
    ↓
组包、解包、分发
```

收到 `EPOLLIN` 并不意味着数据已经进入应用程序的接收缓冲区。它只告诉我们：**现在这个 Socket 处于可读状态，可以尝试读取了。**

所以 Reactor 中的典型处理函数会长这样（示意代码，省略错误处理和关闭逻辑）：

```cpp
void OnReadable(int fd) {
    char buffer[4096];
    ssize_t n = recv(fd, buffer, sizeof(buffer), 0);
    if (n > 0) {
        OnBytesReceived(buffer, static_cast<size_t>(n));
    }
}
```

如果采用边缘触发模式（ET），还要按非阻塞 Socket 的规则继续读取，通常直到 `EAGAIN`。这里不展开 ET 和 LT 的细节，重点是 `recv()` 这一步由应用程序负责。

## Proactor 改了什么？

Proactor 把关注点从“什么时候可以执行 IO”，转移到“某次 IO 操作什么时候完成”。

```text
应用提交异步读取请求
    ↓
异步 IO 系统推进这次读取
    ↓
读取完成，产生完成事件
    ↓
执行与操作关联的完成回调
    ↓
应用处理已经读取的数据
```

以 Asio 风格的接口举例：

```cpp
socket.async_read_some(
    asio::buffer(buffer),
    [&](const auto& ec, std::size_t bytes) {
        if (!ec) {
            OnBytesReceived(buffer.data(), bytes);
        }
    }
);
```

这段只是展示 API 形态，并不是一段独立可运行的 Session 实现。实际代码还必须保证 `buffer` 和相关对象在异步操作完成前一直有效。

与 Reactor 最大的不同在于：调用者提交的是一个**具体的读取操作**，回调报告的是这个操作的**完成结果**。调用者不必在可读事件中亲自调用 `recv()`。

但这不代表“读到了完整的业务消息”。TCP 是字节流，`async_read_some` 也可能只返回部分字节。应用层仍然需要维护接收缓冲区、处理粘包与拆包。

## 所以 Proactor 是 Reactor 的一层封装吗？

这是我一开始最想确认的地方。

答案是：**从设计模式上说，不是；从具体实现上说，可以是。**

两者所描述的通知语义不同：

| | Reactor | Proactor |
| --- | --- | --- |
| 提交或注册 | 关注可读、可写事件 | 提交具体 IO 操作 |
| 收到通知 | 资源已就绪 | 操作已完成 |
| 应用下一步 | 执行读写 | 处理读写结果 |

如果底层操作系统只提供就绪通知，框架完全可以自己维护“待完成的异步读操作”。等 `epoll` 通知可读时，由框架调用非阻塞 `recv()`，然后再调度用户的完成回调：

```text
用户调用 async_read()
        ↓
框架记录待执行读操作
        ↓
epoll 等待可读
        ↓
框架内部调用 recv()
        ↓
框架调度 read 完成回调
```

对使用者而言，这是 Proactor 风格接口；对底层实现而言，它还是 Reactor。

Boost.Asio 的官方文档就明确介绍了这种实现方式：在使用 `select`、`epoll` 或 `kqueue` 的平台上，框架可以在就绪时执行异步操作，再把结果放进完成事件队列。

所以不应该把 Proactor 理解成 Reactor 的“升级版本”，也不能认为采用 Proactor 的框架就一定使用了内核原生异步 IO。

## 那 IOCP 和 io_uring 呢？

如果说 `epoll` 主要提供就绪通知，Windows 的 **Overlapped I/O + IOCP** 则提供了更直接的完成式 IO 机制。应用提交异步操作，完成后可以从完成端口获取对应的完成通知。

Linux 的 **io_uring** 也提供提交与完成队列：

- SQ（Submission Queue）：放入需要执行的操作；
- CQ（Completion Queue）：获取操作完成结果。

使用者通过完成队列确认一次具体操作的结果，这比传统 `epoll` 的就绪事件更接近原生完成式 IO。不过，io_uring 的操作也可能涉及等待就绪、同步完成、重试等内部实现细节；不能简单理解成“任何时候都由一个内核线程替你执行 recv”。

这几个概念处在不同层次：

- Reactor、Proactor：描述如何组织异步 IO 操作和通知；
- `epoll`、IOCP、`io_uring`：操作系统提供的具体接口和机制；
- Asio：向应用程序提供统一异步 API 的 C++ 库，能够依据平台选择不同的底层实现。

## 回到最开始的问题

我原本觉得 Proactor 可能就是 Reactor 外面包了一层回调。后来发现，这句话只能描述**某些实现方案**，不足以定义 Proactor 本身。

真正该记住的是：

> Reactor 告诉应用“现在可以尝试做 IO”；Proactor 报告“之前提交的 IO 操作已经完成”。

具体实现可以重叠，抽象语义并不相同。

这也是为什么在 Linux 上使用 Asio 时，应用写的是异步完成回调，底层却依然可能使用 `epoll`。

## 参考资料

以下资料于 2026-10-15 查阅，用于核对概念和平台实现；本文没有进行代码运行或性能测试。

- [Boost.Asio — The Proactor Design Pattern](https://www.boost.org/doc/libs/latest/doc/html/boost_asio/overview/core/async.html)
- [Microsoft Learn — I/O Completion Ports](https://learn.microsoft.com/en-us/windows/win32/fileio/i-o-completion-ports)
- [Linux man-pages — io_uring(7)](https://man7.org/linux/man-pages/man7/io_uring.7.html)

延伸：[Reactor 和 Proactor，在实际开发中应该如何选择？](reactor-vs-proactor-in-practice.md)
