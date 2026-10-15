---
title: C++ ODR、inline 与 static：为什么头文件中的定义有时不会冲突
created: 2026-10-15T06:47:13Z
updated: 2026-10-15
tags: [C++, ODR, inline, static, 头文件, 链接]
status: review
---

# C++ ODR、inline 与 static：为什么头文件中的定义有时不会冲突

在头文件里写函数定义，多个 `.cpp` 包含后，可能出现重复定义。但如果给函数加上 `inline` 或 `static`，通常又能链接成功。

这两种写法虽然都能避开常见的重复定义错误，背后的语义却完全不同。继续追问就会碰到 ODR（One Definition Rule，单一定义规则）。

## 先区分声明和定义

```cpp
void foo();          // Declaration：声明
void foo() {}        // Definition：定义

extern int value;    // 声明
int value = 10;      // 定义
```

同一个函数可以有多次相容声明，但不能在同一个翻译单元重复定义。

```cpp
void foo() {}
void foo() {}        // 编译时报重复定义
```

## #pragma once 保护的是哪个范围？

假设 `a.h` 和 `b.h` 都包含了 `common.h`，而 `main.cpp` 又同时包含 `a.h`、`b.h`。如果 `common.h` 没有包含保护，预处理结果可能重复出现同一个类定义：

```cpp
struct Player { int hp; };
struct Player { int hp; }; // 同一翻译单元重复定义
```

加入 `#pragma once` 或传统保护宏，可以防止这种**同一翻译单元内**的重复包含。但 `a.cpp` 和 `b.cpp` 是两个独立翻译单元，它们仍然各自需要看到所包含的头文件内容。

因此，头文件保护并不解决跨翻译单元重复定义的问题。

## ODR 到底要求什么？

粗略地说：同一个翻译单元里不能重复定义同一个可定义实体；跨翻译单元时，不同类型的实体适用不同规则。

普通具有外部链接的非 `inline` 函数，如果程序中出现多个定义，违反 ODR：

```cpp
// common.h
#pragma once
void func() {}
```

如果两个 `.cpp` 都包含它，常见链接器会提示 `multiple definition` 或 MSVC 的 `LNK2005`。

但 C++ 允许类、模板、具外部链接的 `inline` 函数等在不同翻译单元中拥有符合要求的多份定义。对于这些允许跨翻译单元多重定义的情况，通常要求定义具有相同的 token 序列，并且定义中名称查找指向相同实体（标准还规定了其他条件与例外）。

```cpp
// common.h
#pragma once
inline int add(int a, int b) {
    return a + b;
}
```

这就适合放进头文件，供多个 `.cpp` 包含。这里 `inline` 的作用不只是建议编译器做函数调用展开，更重要的是改变了多重定义的合法性。编译器**不保证**真的把调用内联展开。

要注意：两个 `inline` 定义不一致时，可能属于“ill-formed, no diagnostic required”（程序不符合规则，但实现不要求给出诊断）。**能链接成功，不代表满足 ODR**。

## static 和 inline 为什么不一样？

```cpp
// common.h
#pragma once
static void func() {}
```

这里的 `static` 修饰命名空间作用域的自由函数，使其拥有内部链接（Internal Linkage）。每个翻译单元中的 `func` 都是**不同的函数实体**，不需要跨翻译单元合并为同一个函数。

相比之下：

```cpp
inline void func() {}
```

这个普通命名空间作用域的 `inline` 函数默认具有外部链接（External Linkage）。在满足 ODR 的情况下，多份定义指向**同一个函数实体**，函数地址也具有相同实体的语义。

不能据此断言两个 `static` 函数的机器码地址在任何工具链设置下都一定不同：链接器可能进行相同代码折叠等优化。讨论语言规则时，最好区分“是否同一个 C++ 实体”和“最终机器码是否占用不同地址”。

## 用局部 static 变量验证

函数内部的 `static` 又是另一个含义：让局部变量拥有静态存储期，而不是决定函数链接属性。

正好可以利用它来观察区别。建立以下四个文件。

**common.h**

```cpp
#pragma once

static int counter() {
    static int count = 0;
    return ++count;
}
```

**a.cpp**

```cpp
#include "common.h"

int callA() {
    return counter();
}
```

**b.cpp**

```cpp
#include "common.h"

int callB() {
    return counter();
}
```

**main.cpp**

```cpp
#include <iostream>

int callA();
int callB();

int main() {
    std::cout << "A: " << callA() << '\n';
    std::cout << "A: " << callA() << '\n';
    std::cout << "B: " << callB() << '\n';
    std::cout << "B: " << callB() << '\n';
    std::cout << "A: " << callA() << '\n';
    std::cout << "B: " << callB() << '\n';
}
```

### 第一次：static 函数

`a.cpp` 和 `b.cpp` 各有独立的 `counter()` 和各自的局部静态变量 `count`。

预期输出：

```text
A: 1
A: 2
B: 1
B: 2
A: 3
B: 3
```

### 第二次：改成 inline 函数

只修改 `common.h` 的函数声明头：

```cpp
inline int counter() {
    static int count = 0;
    return ++count;
}
```

这时 `a.cpp` 和 `b.cpp` 使用的是同一个具有外部链接的内联函数实体，函数内的局部静态变量 `count` 也被共享。

预期输出：

```text
A: 1
A: 2
B: 3
B: 4
A: 5
B: 6
```

这里列出的都是**按语言规则推导的预期结果**，还没有在本次归档中实际执行并核对。

### Windows + VSCode + MSVC 编译

项目目录包含 `main.cpp`、`a.cpp`、`b.cpp`、`common.h`。不要只把当前文件 `${file}` 传给 `cl.exe`；需要一次性传入三个源文件：

```powershell
cl.exe /nologo /EHsc /std:c++17 /Od /Zi main.cpp a.cpp b.cpp /Fe:test.exe
.\test.exe
```

这条命令需要在已配置 MSVC 工具链环境的终端执行，例如 Developer PowerShell for VS。VSCode 对应的 `tasks.json` 示例可见 [浅谈 C++ 的编译与链接](compilation-and-linking.md)。

还可以在 `counter()` 中打印 `&count`，观察两种情况下局部静态变量是否是同一个对象。由于这个函数返回的数值本身就能说明状态独立或共享，地址打印是辅助观察，而不是必要条件。

## 头文件中常见的写法

| 写法 | 多个翻译单元包含 |
| --- | --- |
| `void f();` | 只有声明，正常 |
| `void f() {}` | 普通外部链接函数重复定义，通常报链接错误 |
| `inline void f() {}` | 满足 ODR 条件时合法，代表同一个函数实体 |
| `static void f() {}` | 每个翻译单元都有自己的内部链接函数 |
| `class Player { /* ... */ };` | 符合 ODR 多重定义要求时合法 |
| `extern int value;` | 只有声明；若 ODR-use，程序仍需要合适的定义 |
| `inline int value = 0;`（C++17） | 满足 ODR 条件时合法 |

类内定义的成员函数通常隐式 `inline`；类外写在头文件里的普通成员函数定义，则一般需要显式加 `inline`，或移到一个 `.cpp` 中。C++20 命名模块中还有额外边界，不宜机械套用“类内定义必然 inline”。

## 记下这几个区别

- `#pragma once` 解决**同一翻译单元重复包含**。
- `inline` 允许满足 ODR 的跨翻译单元多重定义，并保持一个函数实体的语义。
- 命名空间作用域的 `static` 让各翻译单元拥有独立的函数实体。
- 函数内部的 `static` 则控制局部变量的存储期；它能否被多处调用共享，还要看外层函数是否为同一个实体。
- ODR 是 C++ 的语言规则，并不等于“链接器能检查到的全部错误”。

和预处理、汇编、链接各阶段的关系，可参见 [浅谈 C++ 的编译与链接](compilation-and-linking.md)。

## 参考资料

- [cppreference: Definitions and ODR](https://en.cppreference.com/w/cpp/language/definition)
- [cppreference: inline specifier](https://en.cppreference.com/w/cpp/language/inline)
