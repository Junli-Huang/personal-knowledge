---
title: 浅谈 C++ 的编译与链接
created: 2026-10-15
updated: 2026-10-15
tags: [C++, 编译, 链接, 翻译单元, MSVC]
status: review
---

# 浅谈 C++ 的编译与链接

之前一直知道 C++ 要先编译再链接，但仔细拆开看，还有几个问题：`.o` 是哪一步生成的？预处理、编译、汇编、链接是否依次使用上一阶段的产物？头文件在这里又扮演什么角色？

这篇先从经典构建流程入手，不展开编译器前后端的具体实现。

## 四个阶段

以 `main.cpp` 为例，可以先理解为：

```text
main.cpp
  ↓ 预处理（Preprocessing）
main.i
  ↓ 编译（Compilation）
main.s
  ↓ 汇编（Assembly）
main.o
  ↓ 链接（Linking）← 其他 .o、静态库等
可执行文件
```

这是一条便于理解的**逻辑流程**，不是说每次构建都会在磁盘上留下 `.i`、`.s` 等中间文件。编译器驱动程序通常直接串起所有步骤；有些编译器后端也能直接输出目标文件，不必写出汇编文本。

### 预处理：先把源码整理成翻译单元

预处理器处理 `#include`、`#define`、`#if`、`#ifdef` 等预处理指令。

- `#include` 将被包含文件的内容纳入当前处理过程；并不会自动把同名的 `.cpp` 一起加入构建。
- 宏会被替换；条件编译会决定哪些代码被保留。
- 注释在翻译早期被移除，不应理解成专门有一个“剔除无用业务代码”的优化阶段。

一个 `.cpp` 连同它包含的头文件经过预处理后，构成一个翻译单元（Translation Unit，TU）。不同的 `.cpp` 通常各自形成翻译单元，即使包含了相同的头文件也一样。

### 编译：理解语义，并生成较低级的表示

编译器不只是逐句将 C++ 翻译成汇编，它还要完成语法与语义分析、类型检查、优化、代码生成等工作。以常见 GCC 的分阶段输出为例，这一步可以得到 `.s` 汇编代码。

### 汇编：将指令编码到目标文件中

汇编器把汇编指令转成目标机器的指令编码，形成目标文件（Object File）。Unix 系统常见扩展名是 `.o`，MSVC 默认是 `.obj`。

目标文件不只有机器码，还包含符号表、重定位信息、代码与数据等节。它通常不是能直接启动的完整程序：还可能存在待解析的符号，而且缺少最终可执行映像所需的组织方式。

### 链接：把独立构建的部分组织起来

多个目标文件可以分别编译，再交给链接器。链接器主要负责符号解析、重定位以及输出文件的布局。

例如：

```cpp
// main.cpp
int add(int, int);

int main() {
    return add(1, 2);
}
```

```cpp
// math.cpp
int add(int a, int b) {
    return a + b;
}
```

编译 `main.cpp` 时，编译器知道 `add` 的声明，但不需要看到其函数体；到了链接阶段，才需要把调用关联到合适的定义。找不到定义时，通常报未解析外部符号；找到多个不允许重复的定义时，通常报重复定义。

静态库（Unix 常见 `.a`，MSVC 常见 `.lib`）可以理解为供链接器选取目标文件的归档。共享库（Linux 常见 `.so`，Windows 常见 `.dll`）则涉及动态链接；**链接不代表把所有依赖代码都复制进可执行文件**。

## 动手观察：GCC 的分阶段输出

下面的命令展示经典四阶段流程：

```bash
g++ -E main.cpp -o main.i
g++ -S main.i -o main.s
g++ -c main.s -o main.o
g++ main.o math.cpp -o app
```

最后一步还让 `g++` 处理 `math.cpp`，仅为了保持例子简短。也可以先把 `math.cpp` 编译为 `math.o` 再一起链接：

```bash
g++ -c math.cpp -o math.o
g++ main.o math.o -o app
```

平时用的 `g++ main.cpp math.cpp -o app`，就是由编译器驱动程序替你组织这些步骤。

## 在 VSCode + MSVC 中编译多个源文件

这次讨论里的实际配置使用 `cl.exe`。VSCode 自动生成的任务中，如果参数只有 `${file}`，那就只会将当前打开的文件交给编译器。例如当前文件为 `main.cpp`，而 `callA()`、`callB()` 分别定义在另外两个源文件中，最终可能遇到 `LNK2019` 未解析外部符号。

对于这样的小实验目录：

```text
test/
├── common.h
├── main.cpp
├── a.cpp
└── b.cpp
```

可以使用以下任务（要求 VSCode 任务所处环境能找到 MSVC 工具链和所需 SDK）：

```json
{
  "version": "2.0.0",
  "tasks": [
    {
      "type": "shell",
      "label": "MSVC build test",
      "command": "cl.exe",
      "args": [
        "/nologo",
        "/EHsc",
        "/std:c++17",
        "/Od",
        "/Zi",
        "/Fe:test.exe",
        "main.cpp",
        "a.cpp",
        "b.cpp"
      ],
      "options": { "cwd": "${fileDirname}" },
      "problemMatcher": ["$msCompile"],
      "group": { "kind": "build", "isDefault": true }
    }
  ]
}
```

保存后可通过 `Ctrl+Shift+B` 构建，终端执行 `.\\test.exe`。这里是可供复现的配置示例，**尚未在当前环境实际验证**。如果启动任务时提示找不到 `cl.exe` 或标准库头文件，需要先确保任务继承了 Visual Studio Developer Command Prompt/PowerShell 配置的编译环境。目录中如果存在多个独立程序，也不应无差别地把所有 `.cpp` 一起编译。

## 最后再看头文件

`#pragma once` 或 `#ifndef` 保护宏，只阻止同一个翻译单元重复包含同一头文件（`#pragma once` 为广泛支持的非标准扩展）；它们**不保证整个项目只处理一次这个头文件**。

这就引出另一个问题：既然两个 `.cpp` 都可能得到相同的头文件定义，为什么类定义可以重复出现，而普通函数定义有时会产生链接错误？这属于 ODR 与链接属性的范围，另记在 [C++ ODR、inline 与 static](odr-inline-static.md)。

## 术语备忘

| 中文 | 英文 |
| --- | --- |
| 声明 / 定义 | Declaration / Definition |
| 预处理 / 预处理器 | Preprocessing / Preprocessor |
| 编译 / 编译器 | Compilation / Compiler |
| 汇编 / 汇编器 | Assembly / Assembler |
| 链接 / 链接器 | Linking / Linker |
| 翻译单元 | Translation Unit |
| 目标文件 | Object File |
| 符号解析 / 重定位 | Symbol Resolution / Relocation |
