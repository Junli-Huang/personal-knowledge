---
title: "C++11/14 互斥锁与读写锁：mutex、lock_guard、shared_lock"
created: 2026-10-18T10:11:00+08:00
updated: 2026-10-18T10:11:00+08:00
tags: [C++, C++14, mutex, 读写锁, 多线程]
status: review
---

# C++11/14 互斥锁与读写锁：mutex、lock_guard、shared_lock

看到下面两段代码，容易产生两个疑问：`lock_guard` 就是互斥锁吗？`shared_lock` 是读锁、`unique_lock` 是写锁吗？实际上需要先区分**锁对象**和**锁管理器**。

## 普通互斥锁：mutex 才是锁对象

```cpp
#include <mutex>

std::mutex mutex;
GameConfig config;

void ReadConfig() {
    std::lock_guard<std::mutex> lock(mutex);
    int level = config.maxLevel;
}

void UpdateConfig(const GameConfig& value) {
    std::lock_guard<std::mutex> lock(mutex);
    config = value;
}
```

`std::mutex` 才是互斥锁；`std::lock_guard<std::mutex>` 是管理它的 RAII 对象。构造时调用 `lock()`，析构时调用 `unlock()`。即使离开作用域或异常展开，也会释放锁。

普通互斥锁是独占的，所以**读与读之间也不能同时持有同一把锁**。

## 读写锁的共享和独占体现在哪里？

```cpp
// C++17
#include <shared_mutex>
#include <mutex>

std::shared_mutex mutex;
GameConfig config;

void ReadConfig() {
    std::shared_lock<std::shared_mutex> lock(mutex);
    int level = config.maxLevel;
}

void UpdateConfig(const GameConfig& value) {
    std::unique_lock<std::shared_mutex> lock(mutex);
    config = value;
}
```

`std::shared_mutex` 是支持两种模式的**锁对象**：

- `lock_shared()` / `unlock_shared()`：共享模式，可有多个并发持有者；
- `lock()` / `unlock()`：独占模式，和共享持有者互斥。

`std::shared_lock` 用 RAII 管理共享模式，`std::unique_lock` 用 RAII 管理独占模式。

`shared_lock` 不能识别“是不是读”，`unique_lock` 也不能识别“是不是写”；名称只是通常的用途。用共享模式并发修改没有同步保护的普通字段，仍可能构成数据竞争。

## lock_guard、unique_lock、shared_lock 区别

| 类型 | 加锁方式 | 特点 |
| --- | --- | --- |
| `lock_guard<Mutex>` | 独占 `lock()` | 简单，持锁期间无法手动提前 unlock |
| `unique_lock<Mutex>` | 独占 `lock()` | 可延迟获取、提前解锁、转移所有权 |
| `shared_lock<SharedMutex>` | 共享 `lock_shared()` | 管理共享模式，支持更多锁管理操作 |

例如：

```cpp
std::mutex m;

// 临界区固定，简单使用
{
    std::lock_guard<std::mutex> guard(m);
    // 访问共享数据
}

// 需要提前释放或与 condition_variable 协作
{
    std::unique_lock<std::mutex> lock(m);
    // 访问共享数据
    lock.unlock();
    // 锁已经不再持有
}
```

`unique_lock` **不专属于读写锁的写端**；它也常配合普通 `std::mutex` 使用。反过来，`lock_guard` 也可以管理支持独占接口的读写锁。

## C++11、C++14、C++17 版本差异

| 工具 | 标准 |
| --- | --- |
| `std::mutex`、`std::lock_guard`、`std::unique_lock` | C++11 |
| `std::shared_timed_mutex`、`std::shared_lock` | C++14 |
| `std::shared_mutex` | C++17 |
| 类模板实参推导（CTAD） | C++17 |

在 **C++14** 中，应写：

```cpp
#include <mutex>
#include <shared_mutex>

struct GameConfig {
    int maxLevel = 100;
};

std::shared_timed_mutex configMutex;
GameConfig config;

int ReadConfig() {
    std::shared_lock<std::shared_timed_mutex> lock(configMutex);
    return config.maxLevel;
}

void UpdateConfig(const GameConfig& value) {
    std::unique_lock<std::shared_timed_mutex> lock(configMutex);
    config = value;
}
```

注意 `std::shared_timed_mutex` 名字里有 `timed`，并不代表只能超时加锁；普通共享锁和独占锁也能用。

原示例中 `std::shared_lock lock(mutex)` 省略模板实参的写法依赖 C++17 CTAD，在 C++14 需要写出模板参数。

## 和传统 pthread_rwlock_t 有什么关系？

在 POSIX 下，原生接口更像：

```cpp
pthread_rwlock_t rwlock;

pthread_rwlock_rdlock(&rwlock); // 读模式
pthread_rwlock_unlock(&rwlock);

pthread_rwlock_wrlock(&rwlock); // 写模式
pthread_rwlock_unlock(&rwlock);
```

它和 C++ 的共享/独占锁具有相似的用途，但不是“完全相同的具体实现”：公平性、读者或写者优先策略、递归限制等细节随实现不同而变化。

C++ 标准库的 RAII 管理器可以减少手工遗漏解锁的问题；pthread 的函数式接口更直接展示“读加锁/写加锁/解锁”三个动作。

## 游戏服中到底选哪种？

- **单逻辑线程独占业务状态**：不需要给 `Player`、`Scene` 容器随处加锁。
- **少量跨线程共享、临界区很短**：先使用普通 `mutex`，简单可靠。
- **多线程频繁读取，写入少且临界区足够长**：评估读写锁。
- **高频读、低频写的不可变配置**：也可以考虑快照，避免每次读都和写竞争。
- **读性能确实遭遇同步瓶颈**：再评估 RCU 等复杂回收方案。

读写锁不保证比普通互斥锁快。短临界区、锁内部开销、读写竞争与调度公平性，都可能影响最终结果。是否换锁，应该以实际延迟和吞吐测试为依据。

## 参考资料

- [cppreference — std::mutex](https://en.cppreference.com/w/cpp/thread/mutex)
- [cppreference — std::shared_timed_mutex](https://en.cppreference.com/w/cpp/thread/shared_timed_mutex)
- [cppreference — std::shared_mutex](https://en.cppreference.com/w/cpp/thread/shared_mutex)
- [cppreference — std::shared_lock](https://en.cppreference.com/w/cpp/thread/shared_lock)

相关：[深入浅出 RCU](../networking/rcu-read-copy-update.md)
