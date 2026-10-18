---
title: C++ static 关键字详解：变量、函数、类成员与翻译单元
created: 2026-10-18T14:14:00+08:00
updated: 2026-10-18
tags: [C++, C++14, static, 内部链接, 静态局部变量, 类成员, inline]
status: review
---

# C++ static 关键字详解：变量、函数、类成员与翻译单元

从 `static int a = 10;` 延伸出的核心问题是：**为什么写在头文件中的静态变量每个翻译单元各有一份，而类内定义的静态成员函数及其局部静态变量却能共享？**

原因是 `static` 在不同上下文中表达不同含义，必须区分**链接属性**、**存储期**和**成员是否依赖对象**。以下主要针对 C++14、同一个正常链接的程序映像讨论。

## 1. 三类 static

| 所在位置 | 主要语义 |
| --- | --- |
| 命名空间作用域的变量或普通函数 | 赋予名字内部链接属性 |
| 函数内局部变量 | 静态存储期，跨调用保持状态 |
| 类的成员变量或成员函数 | 成员关联类而非特定对象；静态函数无 `this` |

不能简单用“`static` 就是全局共享”或“`static` 就是 private”概括所有情况。

## 2. 全局 static 变量：头文件与 cpp

**config.h**

```cpp
#pragma once
static int a = 10;
```

```cpp
// player.cpp
#include "config.h"
void PlayerTest() { a = 100; }
```

```cpp
// scene.cpp
#include "config.h"
void SceneTest() { a = 200; }
```

每个翻译单元处理 `config.h` 后，拥有自己的内部链接变量 `a`。这里的 `a` 是两个不同对象：更改一份不会更改另一份，**它们的对象地址也不同**。即使一个 TU 经不同头文件间接包含 `config.h` 多次，包含保护仍能避免同一 TU 重复定义。

如果把 `static int a = 10;` 直接写进 `config.cpp`，则只在 `config.cpp` 这个翻译单元定义它。别的文件写 `extern int a;` 不能直接链接到这个内部链接对象。

所谓“类似 private”仅是方便记忆：`private` 是类的访问控制，`static` 在此控制名字的链接属性，并非内存保护。另一个 `.cpp` 可以通过公开的函数间接访问该对象。

## 3. 普通 static 函数：头文件里每个 TU 一个实体

```cpp
// common.h
#pragma once

static int Next()
{
    static int count = 0;
    return ++count;
}
```

```cpp
// a.cpp
#include "common.h"
int CallA() { return Next(); }
```

```cpp
// b.cpp
#include "common.h"
int CallB() { return Next(); }
```

普通的命名空间作用域 `static` 函数有**内部链接属性**：`a.cpp` 和 `b.cpp` 各自拥有不同的 `Next()` 函数实体。因此它们内部的局部 `static int count` 也分别存在。

假设调用顺序为 `CallA(), CallA(), CallB(), CallB()`，预期返回 `1, 2, 1, 2`。

注意区分函数实体与机器码：优化器或链接器可能内联、折叠相同机器指令，不能仅靠反汇编看到的代码份数判断语言层面有几个函数实体。上例中独立的可变 `count` 对象才是更直接的观察依据。

## 4. 函数内 static 局部变量：每个函数实体的状态

```cpp
void Test()
{
    static int count = 0;
    ++count;
}
```

`count` 的**作用域**仍在 `Test` 内部，但它具有**静态存储期**：不是每调用一次函数就重新创建并初始化一次。它在程序生命周期内保留状态。

此例中 `count = 0` 初始化只进行一次。对于动态初始化的函数局部静态变量，C++11 起规定并发首次进入时的初始化具有线程安全保障；但**初始化线程安全不等于后续 `++count` 并发读写安全**，实际多线程修改仍需同步或原子类型。

## 5. 类的 static 数据成员：所有对象共享

```cpp
// Player.h
class Player
{
public:
    static int maxLevel;
    int level = 1;
};
```

```cpp
// Player.cpp
#include "Player.h"
int Player::maxLevel = 100;
```

```cpp
Player p1;
Player p2;
Player::maxLevel = 200; // p1、p2 看到同一个静态数据成员
```

静态数据成员不随每个 `Player` 对象分别存储一份。`level` 才是每个对象各有一份的普通数据成员。

在 C++14 中，像这样的非 `const` 静态数据成员一般在类内**声明**，在一个 `.cpp` 中**定义**。不要误用 C++17 的 `inline static int maxLevel = 100;` 写法。

## 6. 类的 static 成员函数：没有 this

```cpp
class Player
{
public:
    int level = 1;
    static int maxLevel;

    static int GetMaxLevel()
    {
        // return level; // 错：没有 this，不能直接访问实例成员
        return maxLevel;
    }
};
```

调用 `Player::GetMaxLevel()` 不需要创建对象。类成员函数的 `static` **不赋予内部链接属性**；它的主要意义是该函数不绑定某个具体对象。

### 类内定义为什么跨翻译单元是同一个函数？

```cpp
// Player.h
class Player
{
public:
    static int Next()
    {
        static int count = 0;
        return ++count;
    }
};
```

在 C++14 中，**类内定义的成员函数隐式为 inline**。只要所在类满足相应 ODR 条件、函数具有适当的外部链接语义，不同翻译单元里的定义对应同一个函数实体，`Next()` 内部的 `count` 也是同一个对象。

假设顺序是：

```cpp
// a.cpp 调用两次 Player::Next() -> 1、2
// b.cpp 再调用两次 Player::Next() -> 3、4
```

这次**不是 static 关键字让多个 TU 共享函数**，关键在于类内定义的成员函数隐式 `inline`，而 `static` 局部变量属于这同一个函数实体。

### 如果类内只声明，类外定义呢？

```cpp
// Player.h
class Player {
public:
    static void Test();
};
```

```cpp
// Player.cpp
#include "Player.h"

void Player::Test() {} // 定义时不再写 static
```

其他 `.cpp` 包含 `Player.h` 后可以调用这个静态成员函数；它没有因为写在 `.cpp` 中就变成“仅该 TU 私有”。

## 7. 普通类成员函数也有相同的局部 static 共享行为

```cpp
class Player
{
public:
    int Next()
    {
        static int count = 0;
        return ++count;
    }
};
```

```cpp
Player p1, p2;
// p1.Next() -> 1
// p2.Next() -> 2
```

函数不是静态成员，也不妨碍所有 `Player` 对象调用**同一成员函数实体**。局部的 `static count` 是共享的，而不是每个对象一份。

这也说明：**成员函数的代码和对象的成员数据不是同一种存储关系**。非静态成员函数可以借助 `this` 操作具体对象，不能因此推断每个对象有一份函数代码。

## 8. 与 inline 的关系

```cpp
// common.h
inline int Next()
{
    static int count = 0;
    return ++count;
}
```

此处普通自由函数没有 `static` 修饰，却因 `inline` 和符合 ODR 的多翻译单元定义而代表同一个函数实体，其局部 `static count` 也共享一份。

对照：

| 头文件中的函数写法 | 多翻译单元中的函数实体 | 内部局部 static |
| --- | --- | --- |
| `static void f() {}` | 各 TU 一个 | 各 TU 一个 |
| `inline void f() {}` | 同一个（满足 ODR） | 同一个 |
| `class X { static void f() {} };` | 同一个（正常外部链接的类） | 同一个 |
| `class X { void f() {} };` | 同一个（正常外部链接的类） | 同一个 |

额外边界：若类本身定义在匿名命名空间等内部链接上下文，也可能每个 TU 各有不同类和成员函数实体，不能无条件说“任何类内函数都全程序唯一”。本文表格讨论通常头文件里、具有外部链接的同一个类。

## 9. 作用域、链接属性、存储期分别问什么？

- **作用域（Scope）**：这个名字从哪里能被直接查找到？
- **链接属性（Linkage）**：不同位置的同名声明是否指向同一实体？
- **存储期（Storage Duration）**：变量对象从什么时候存在到什么时候？

函数内的 `static int count` 作用域局限于函数体，存储期却贯穿程序；命名空间作用域的 `static int a` 具有内部链接属性和静态存储期。它们不是一个维度。

## 10. 结论与常见坑

1. 头文件中定义普通全局 `static` 变量：每个翻译单元独立状态，容易引发“不知道为什么两个模块数值不同”的问题。
2. 头文件中定义普通全局 `static` 函数：各 TU 不同函数实体；函数内的局部静态变量也分别存在。
3. 类内定义的 `static` 成员函数：函数不绑定对象，同时因类内定义的 `inline` 语义而通常跨 TU 为同一函数实体。
4. 非静态类成员函数里的局部静态变量：同样不是每个对象一份。
5. 若需要跨文件共享变量，应明确使用外部链接声明/定义方案；若需要封装状态，不要只依赖“加个 static”来解决所有可见性问题。
6. 多线程服务端中所有共享且可修改的静态状态，都应明确并发访问策略。

## 相关资料

- [变量的声明、定义与初始化](declaration-definition-initialization.md)
- [extern、翻译单元与链接属性](extern-translation-unit-linkage.md)
- [ODR、inline 与 static：为什么头文件中的定义有时不会冲突](odr-inline-static.md)

> 示例输出属于按 C++14 语言规则推导的预期行为，并未在这次归档过程中执行编译测试。
