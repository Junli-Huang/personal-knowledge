---
title: ar、tar 与静态库 .a
created: 2026-10-15T07:11:48Z
updated: 2026-10-15
tags: [C++, Linux, ar, tar, 静态库, 归档]
status: review
---

# ar、tar 与静态库 .a

看压缩和打包工具时碰到 `ar`、`tar`，再想到 C/C++ 静态库常见的 `.a`。这几个名字都和 archive（归档）有关，但到底有什么区别？`ar` 只能处理 `.o` 吗？

## ar 和 tar 都是归档，不等于压缩

`ar` 是 archiver，`tar` 是 tape archive。两者的基本工作都是把多个文件组织到一个归档文件中，默认都**不压缩文件内容**。

```bash
ar rcs data.a a.txt b.json
tar -cf data.tar a.txt b.json
```

两条命令都能把文本、JSON 等普通文件放进归档。扩展名 `.a` 只是惯例，不会让归档自动变成有效的 C/C++ 静态库。

区别主要在用途：`tar` 能保留目录层级和相关文件元数据，适合备份、分发文件；传统 `ar` 主要处理扁平的文件成员，适合构建静态库等容器格式。二者都不是通用意义上的压缩算法。

```bash
tar -czf source.tar.gz src/   # tar 归档，再用 gzip 压缩
tar -tf source.tar.gz         # 查看内容
```

这里的 `z` 才表示 gzip。类似的还有 `.tar.xz`、`.tar.zst`。

## .a 为什么和 ar 有关？

Unix/Linux 下常见的 `.a` 静态库，通常就是一种 `ar` 归档，里面装的是编译生成的目标文件（`.o`）。

```bash
g++ -c a.cpp b.cpp
ar rcs libdemo.a a.o b.o
ar t libdemo.a
```

`ar t` 用来列出成员，预期可以看到 `a.o`、`b.o`。其中 `rcs` 的含义是：

- `r`：加入或替换成员。
- `c`：创建归档时不输出提示。
- `s`：生成或更新供链接器使用的符号索引。

`ar` 做的是归档，不负责把这些 `.o` 的符号解析、重定位成一个完整程序。真正链接时，可以写：

```bash
g++ main.o -L. -ldemo -o app
```

链接器一般按未解析符号的需要，从静态库中提取相应目标文件成员；不是直接把整个归档原封不动地塞进可执行文件。具体提取和丢弃行为还会受链接器选项、目标文件粒度等影响。

关于 `.o` 的产生过程和链接阶段，另见 [浅谈 C++ 的编译与链接](compilation-and-linking.md)。

## ar 能放非 .o 文件吗？

能。比如：

```bash
ar q data.a readme.txt config.json icon.png
ar t data.a
ar p data.a config.json
ar x data.a
```

`q` 是追加成员，`t` 列出成员，`p` 输出成员内容，`x` 提取成员。这些命令不要求成员必须是 `.o`。

可归档的还包括 ELF 可执行文件、`.so`、甚至另一个 `.a`。但**能放进去**不等于**链接器能把它当作静态库目标文件使用**：

- 普通 JSON、图片不会因为进入 `.a` 就变成可链接代码。
- 把 `.so` 放进 `ar` 归档，也不会自动转化为静态库。
- 把一个 `.a` 作为成员放进另一个 `.a`，不会自动把内层 `.o` 展开合并。

`ar` 也不适合代替 `tar` 保存完整目录树。传统归档的成员名通常是扁平的，来自不同目录的同名文件容易造成歧义。GNU、BSD、LLVM 的 `ar` 实现对长文件名、路径和特殊格式的支持存在差异。

## 除了静态库，还有什么用途？

### Debian 的 .deb 软件包

这是 `ar` 保存非 `.o` 文件的典型例子。可以用：

```bash
ar t package.deb
```

常见的 Debian 二进制包包含：

```text
debian-binary
control.tar.xz
data.tar.xz
```

外层用 `ar` 封装，内部的 `tar` 负责保存目录结构，再由 xz 等算法压缩。实际压缩后缀因软件包而异。制作软件包通常使用 Debian 专用工具，而不是手工拼装 `ar` 成员。

### 构建系统和交叉编译

CMake 的 `add_library(demo STATIC ...)` 在常见 Unix 工具链下会生成 `.a`；嵌入式 ARM 工具链也有 `arm-none-eabi-ar` 等归档工具。

GNU ar 还支持薄归档（thin archive）：

```bash
ar rcT libdemo.a a.o b.o
```

它主要记录外部目标文件的引用，而不是把目标文件内容全部复制进去，有利于减少构建过程中的复制成本。但引用的文件一旦移动或丢失，归档可能无法正常用于链接，因此不适合直接作为独立交付物。

## 该怎么选？

| 需求 | 通常选择 |
| --- | --- |
| 将多个目标文件组成静态库 | `ar` |
| 查看、提取静态库中的成员 | `ar t` / `ar x` |
| 打包目录、保留目录结构 | `tar` |
| 打包并压缩目录 | `tar` 配合 gzip、xz 或 zstd |
| 制作 Debian 软件包 | `dpkg-deb` 等专用工具（底层采用 ar 容器） |

所以 `ar` 的范围其实比 `.o` 广得多，只是现代开发里最常碰到的用途仍然是静态库。它和 `tar` 都叫归档工具，但两者并不是互相替代的关系。

还有一个可以继续研究的问题：静态库里明明有某个函数，为什么链接时仍可能出现 undefined reference？这涉及静态库的扫描顺序、符号索引，以及 `--whole-archive` 等选项，和归档格式本身需要分开理解。

> 本文命令为说明性示例，尚未在当前环境逐条执行验证；具体行为应以所用 `ar`、`tar` 和链接器版本为准。
