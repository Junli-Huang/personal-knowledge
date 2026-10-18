---
title: extern、翻译单元与链接属性：多个 cpp 为什么访问同一个变量
created: 2026-10-18T14:13:00+08:00
updated: 2026-10-18
tags: [C++, C++14, extern, 翻译单元, 链接, ODR]
status: review
---

# extern、翻译单元与链接属性：多个 cpp 为什么访问同一个变量

一个自然的疑问是：`config.h` 被几个 `.cpp` 包含之后，每个翻译单元都看到了 `g_maxPlayers`，难道不就每个源文件都有一份数据吗？

答案是：**看到同一个声明，并不等于分别定义同一个变量。**

## 1. 翻译单元与 include

一般而言，一个 `.cpp` 及其通过 `#include` 纳入的头文件内容，经预处理后形成一个**翻译单元（Translation Unit, TU）**。

```text
config.h ──include──> config.cpp ──> config.obj
         ├─include──> player.cpp ──> player.obj
         └─include──> scene.cpp  ──> scene.obj
```

这些 `.cpp` 独立编译。`#pragma once` 防止同一翻译单元内头文件被重复展开，并不让整个程序只包含一次头文件。

## 2. 标准的 extern 用法

**config.h**

```cpp
#pragma once
extern int g_maxPlayers;
```

**config.cpp**

```cpp
#include "config.h"
int g_maxPlayers = 1000;
```

**player.cpp**

```cpp
#include "config.h"

void PlayerTest()
{
    g_maxPlayers = 2000;
}
```

**scene.cpp**

```cpp
#include "config.h"
#include <cstdio>

void SceneTest()
{
    std::printf("%d\n", g_maxPlayers);
}
```

如果先执行 `PlayerTest()`，随后在同一线程调用 `SceneTest()`，就会输出 `2000`。这里没有为每个包含头文件的 `.cpp` 各创建一个 `g_maxPlayers`；`extern int g_maxPlayers;` 是同一外部变量的声明，真正定义在 `config.cpp`。

注意：如果多个线程同时读写这个普通 `int`，还要满足线程同步规则；不能因为 `extern` 共享变量就忽略数据竞争。

## 3. 变量的地址属于哪个源文件？

`int g_maxPlayers = 1000;` 的定义位于 `config.cpp`，但**运行时内存地址不是“属于 .cpp 文件”**。源文件组织的是代码，运行时对象存在于进程的内存中。

这个全局 `int` 具有静态存储期，通常放在可执行映像的已初始化数据区域（如 `.data`）；零初始化的类似变量通常可能落在 `.bss`。具体布局不是 C++ 标准保证。

可以分别在两个源文件打印：

```cpp
#include "config.h"
#include <cstdio>

void PrintAddress()
{
    std::printf("%p\n", static_cast<void*>(&g_maxPlayers));
}
```

对于同一个程序映像中引用的同一对象，打印出来的地址相同；源文件边界并不产生变量副本。不同进程则各有各的地址空间。

## 4. 编译与链接各自负责什么？

1. 编译 `config.cpp`：生成带有 `g_maxPlayers` 定义信息的目标文件。
2. 编译 `player.cpp`、`scene.cpp`：它们依据声明使用该名字，对外部符号的引用需要得到解析。
3. 链接：连接引用与定义，完成重定位等工作，生成可执行文件或其他链接产物。

在 MSVC 中，通常对应 `.obj` 目标文件。更完整的阶段介绍见 [浅谈 C++ 的编译与链接](compilation-and-linking.md)。

## 5. 什么是链接属性？

**外部链接（External Linkage）**：在符合规则的前提下，不同翻译单元可通过相应声明引用同一实体。

```cpp
// config.cpp：命名空间作用域
int g_maxPlayers = 1000; // 通常具有外部链接

// 其他 cpp
extern int g_maxPlayers; // 引用同一外部变量
```

**内部链接（Internal Linkage）**：名字在当前翻译单元内标识该实体，其他翻译单元无法用外部链接声明直接引用这个实体。

```cpp
// config.cpp
static int localConfig = 10; // 内部链接
```

`extern int localConfig;` 写到另一个 `.cpp` 中并不能找到上面这个内部链接变量。这里 `static` 类似“只在本翻译单元可直接按名字访问”，但并不是类的 `private` 访问控制，也不阻止通过导出函数/指针间接访问。

补充边界：命名空间作用域的非 `extern`、非 `inline` `const` 变量通常默认具有内部链接属性，不能把“全局变量都外部链接”作为无条件结论。

## 6. 为什么头文件定义变量会出问题？

```cpp
// config.h —— 不推荐这样写
#pragma once
int g_maxPlayers = 1000;
```

当多个 `.cpp` 包含这个头文件，就出现了多个具有外部链接属性的普通变量定义。这违反 **ODR（One Definition Rule，单一定义规则）**，MSVC 通常报告 `LNK2005`（重复定义）。

```cpp
// config.h
extern int g_maxPlayers; // 头文件只有声明

// config.cpp
int g_maxPlayers = 1000; // 唯一定义
```

找不到被使用的外部变量定义时，链接阶段则可能报告 `LNK2001` 或 `LNK2019`，取决于具体符号引用和诊断方式。

另外，`extern int a = 10;` 在命名空间作用域仍是**定义**，不是单纯声明。

## 7. 与 C++14 的 static、inline 如何关联？

| 头文件中的写法 | 多翻译单元包含后的含义 |
| --- | --- |
| `extern int a;` | 各 TU 可声明同一外部变量，另需定义 |
| `int a = 10;` | 多份普通外部链接变量定义，违反 ODR |
| `static int a = 10;` | 每个 TU 一个独立内部链接变量 |
| `static void f() {}` | 每个 TU 一个独立内部链接函数实体 |
| `inline void f() {}` | 满足 ODR 要求时，同一函数实体 |
| `inline int a = 10;` | **C++17 起**才有 inline 变量，不适用于 C++14 |

关于例子中“同一个函数实体”以及静态局部变量是否共用，请阅读 [C++ static 关键字详解](static-variables-functions-members.md) 和 [ODR、inline 与 static](odr-inline-static.md)。

## 8. 游戏服务端开发中的提醒

共享一份全局配置并不等于它适合被所有模块随意修改。多线程 GameServer 若要共享可变配置，需要约束写入者、同步机制和配置生命周期。根据工程规模，可以使用只读快照、配置对象或显式依赖传递，避免难以追踪的全局可变状态。

**一句话**：`#include` 让每个翻译单元看到声明；具有外部链接的同一变量是否真正存在，由定义与链接来决定。
