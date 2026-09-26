# Monash Study Agent 整体架构设计 V3.0

> 本文档负责 Monash Study Agent 的整体架构、模块关系、技术栈与 Resume MVP 路线。
>
> Long-term Memory 的详细设计，包括 Memory 类型、Scope、写入与更新规则、Recall、生命周期、SQLite Schema 和测试标准，以 [Memory 设计补充](./Monash_Study_Agent_Memory_设计补充.md) 为准。
>
> **文档状态：设计基线与路线图。** 本文中的“当前开发目标”“第一阶段”和 Resume MVP 是设计时的计划，不是现行代码清单；实现状态以 [Codebase Reference](./PROJECT_CODEBASE_REFERENCE.md) 的最新验证快照和工作区说明为准。已实现的 Web UI、运行路径、验证结果和未完成边界请查 Codebase Reference 与 [UI Implementation Reference](./UI_IMPLEMENTATION_REFERENCE.md)。

## 1. 项目定位

Monash Study Agent 是一个围绕大学课程资料构建的本地优先学习 Agent。

当前开发目标是先完成一个：

```text
真实可运行
可以 Demo
核心技术全部真实接入
可以放入简历
后续能够持续扩展
```

的 Resume MVP。

第一阶段优先完成完整纵向链路：

```text
Course Files
↓
Normalization
↓
LightRAG
↓
Agent Tools
↓
Long-term Memory
↓
Multi-Agent
↓
DeepSeek
↓
UI
```

核心技术体系：

```text
TypeScript
Python

DeepSeek Harness
DeepSeek Models

LightRAG
Docling

Long-term Memory
Multi-Agent / Subagent

SQLite

React
Electron
```

核心原则：

> 第一阶段优先让每一个核心模块真实存在并能够端到端运行；后续迭代主要提升检索效果、Memory 质量、Agent 协作能力、UI 完整度和课程覆盖范围。

------

# 2. 总体架构

```text
                         User
                           │
                           ▼
                  Monash Study UI
                           │
                           ▼
                 DeepSeek Harness
                    Agent Runtime
                           │
                           ▼
                    Main Study Agent
                           │
          ┌────────────────┼─────────────────┐
          │                │                 │
          ▼                ▼                 ▼
      Memory Layer       Tools          Subagents
          │                │                 │
       SQLite       search_knowledge     Research Agent
                           │                 │
                           ▼                 ▼
                  Knowledge Service     Agent Loop
                           │
                        LightRAG
                           │
                  Normalized Content
                           │
                   Resource Catalog
                           │
                  Local Course Library
          │                │                 │
          └────────────────┼─────────────────┘
                           ▼
                     Evidence Context
                           │
                           ▼
                    DeepSeek Models
                           │
                           ▼
                        Answer
```

------

# 3. 模块职责

项目主要分成七层：

```text
1. Product / UI
2. Agent Runtime
3. Agent Orchestration
4. Multi-Agent
5. Memory
6. Knowledge / RAG
7. Course Sources
```

具体职责：

```text
Monash Study UI
→ 用户交互
→ 课程选择
→ Chat
→ Evidence 展示
→ Agent 状态展示

DeepSeek Harness
→ Session
→ Conversation
→ Agent Loop
→ Tool Calling
→ Model Runtime
→ Subagent Runtime
→ Session Persistence

Main Study Agent
→ 理解用户问题
→ 调用课程工具
→ Recall Memory
→ 分配复杂任务
→ 综合最终答案

Research Subagent
→ 独立执行研究任务
→ 多轮课程资料检索
→ 整理 Evidence
→ 返回结构化研究结果

Memory Layer
→ 用户偏好与学习状态
→ 薄弱点与重要学习经历
→ 个性化 Study Strategy
→ Global / Course / Topic Memory Scope
→ 跨 Session Recall 与 Memory Lifecycle

Knowledge Service
→ Normalization
→ Document Parsing
→ LightRAG Index
→ LightRAG Query
→ Evidence 构建

Resource Catalog
→ 课程资源身份
→ 文件 Hash
→ Normalization 状态
→ Index 状态

Course Sources
→ Moodle Downloader
→ Ed Downloader
→ 本地课程资料
```

------

# 4. DeepSeek Harness

DeepSeek Harness 作为整个产品内部的 Agent Runtime。

主要复用能力：

```text
Session
Conversation
Agent Loop
Tool Calling
Model Runtime
Subagent
Session Persistence
Plugin / Cordis Runtime
```

核心执行模式：

```text
User
 ↓
DeepSeek
 ↓
Tool Call
 ↓
Tool Result
 ↓
DeepSeek
 ↓
继续调用 Tool / Subagent
 ↓
Final Answer
```

Monash Study Agent 在 Harness 之上增加：

```text
课程知识
Memory
RAG
课程 Tool
Study Prompt
Research Subagent
Evidence
UI
```

------

# 5. Main Study Agent

Main Study Agent 是用户直接交互的主 Agent。

主要职责：

```text
理解课程问题
读取当前课程上下文
Recall Memory
调用 Knowledge Tool
分配复杂研究任务
调用不同 DeepSeek 模型
综合 Evidence
生成最终回答
```

普通问题：

```text
User
 ↓
Main Study Agent
 ↓
search_knowledge
 ↓
LightRAG
 ↓
Evidence
 ↓
DeepSeek
 ↓
Answer
```

例如：

```text
“DFA 和 NFA 有什么区别？”
```

Main Agent 可以调用：

```text
search_knowledge(
    course="FIT2014",
    query="DFA NFA difference"
)
```

取得课程 Evidence 后生成回答。

------

# 6. Multi-Agent

V3.0 第一阶段采用：

```text
Main Study Agent
+
Research Subagent
```

形成最小 Multi-Agent 架构。

## Main Study Agent

负责：

```text
用户交互
任务理解
任务分解
Subagent 调度
最终综合
```

## Research Subagent

负责：

```text
课程资料研究
多轮 LightRAG 检索
Evidence 整理
资料之间的关系分析
返回研究结果
```

典型流程：

```text
User:
帮我全面复习 FIT2014 Mid-sem
        ↓
Main Study Agent
        ↓
拆解研究目标
        ↓
spawn Research Subagent
        ↓
Research Subagent
        │
        ├── search_knowledge
        ├── 再次 search_knowledge
        ├── 收集 Evidence
        ├── 对比 Lecture / Tutorial / Discussion
        └── 输出 Research Result
        ↓
Main Study Agent
        ↓
DeepSeek 综合
        ↓
Revision Plan
```

后续可以自然扩展：

```text
Exam Planner Agent
Revision Agent
Forum Research Agent
Course Summary Agent
```

所有 Subagent 都通过统一接口与 Main Agent 协作。

------

# 7. Tool Layer

第一版核心 Tool 保持精简。

主要包含：

```text
search_knowledge
get_resource
recall_memory
manage_memory
```

后续可以继续加入：

```text
search_ed
search_moodle
get_assignment
get_exam_scope
```

第一阶段课程内容通过本地 Downloader 数据进入 Knowledge Base。

Tool 的目标是：

```text
Agent
↓
统一 Tool Interface
↓
底层 Service
```

从而让 Agent Prompt 与底层具体实现保持分离。

系统在 completed turn 后通过：

```text
MemoryService.observe()
```

自动发起 Post-turn Observation。Main Agent 在对话过程中通过：

```text
manage_memory
```

主动发起 Agent-controlled Memory Formation。这两条路径共享统一的 Memory Service / Resolver，职责按触发来源与执行时机划分；二者均适用完整的 Memory lifecycle operation。

------

# 8. Decision Layer

第一阶段由 DeepSeek 完成轻量 Decision。

定义统一：

```text
DecisionProvider
```

例如：

```ts
interface DecisionProvider {
  classifyIntent(query: string): Promise<IntentDecision>
  selectModel(task: TaskContext): Promise<ModelDecision>
}
```

第一阶段：

```text
DecisionProvider
        ↓
DeepSeekDecisionProvider
```

后续：

```text
DecisionProvider
        ↓
JEVDecisionProvider
```

Study Controller 与其他模块只依赖：

```text
DecisionProvider
```

从而为后续引入 TypeSafe JEV 保留稳定接口。

------

# 9. Model Policy

第一版采用两级 DeepSeek Model Policy。

## Fast Model

负责：

```text
Query Rewrite
简单分类
简单课程问答
Memory Candidate Extraction
短文本整理
简单 Retrieval Query
```

## Strong Model

负责：

```text
复杂规划
多资料综合
长文本解释
考试复习
Research Result 综合
复杂 Multi-Agent Task
```

统一通过：

```text
ModelPolicy
```

选择模型。

例如：

```ts
interface ModelPolicy {
  selectModel(task: ModelTask): ModelProfile
}
```

这样模型策略可以持续迭代，而业务模块保持稳定。

------

# 10. Long-term Memory

V3.0 正式加入独立 Long-term Student Memory。

Memory 与课程知识拥有独立生命周期：

```text
Course Knowledge
→ Knowledge Service / LightRAG

Student Memory
→ Memory Service / SQLite
```

当前 Session 的 Conversation Context 由：

```text
DeepSeek Harness
```

管理。

跨 Session Student Memory 由：

```text
Memory Service
```

管理。

第一阶段支持五类 Long-term Memory：

```text
Preference
Study Progress
Weakness / Mistake
Learning Episode
Study Strategy
```

其中：

```text
Preference
→ 长期交互与学习偏好

Study Progress
→ 当前课程 / Topic 学习状态

Weakness / Mistake
→ 当前值得关注的薄弱点

Learning Episode
→ 值得未来参考的具体学习经历

Study Strategy
→ 以后更适合该学生的教学与解释方式
```

Memory 同时具有 Scope：

```text
global
course
topic
```

详细的 Memory 类型、Scope、Canonical State、生命周期与写入规则统一参考：

```text
[Memory 设计补充](./Monash_Study_Agent_Memory_设计补充.md)
```

------

# 11. Memory Workflow

Memory Write 使用 **Hybrid Memory Formation**：

```text
Background / Post-turn Observation
+
Agent-controlled manage_memory
```

两条 formation path 共享同一套 Memory Service / Resolver 与 persistence pipeline。它们的职责按触发来源与 timing 划分，每条路径均可形成完整的 Memory operation。

一次普通请求：

```text
User Query
    ↓
Main Study Agent
    ↓
Load Global Memory
    ↓
Recall Course / Topic Memory
    ↓
Relevant Student Memory
    ↓
search_knowledge
    ↓
Course Evidence
    ↓
DeepSeek
    ↓
Answer
```

两条 Memory Formation 路径：

```text
Completed Turn                         Main Study Agent
      │                                      │
      ▼                                      ▼
MemoryService.observe()                 manage_memory
      │                                      │
      └─────────────────┬─────────────────┘
                       ▼
                 Memory Candidate
                       │
                       ▼
                 Memory Resolution
                       │
                       ▼
       ADD / UPDATE / RESOLVE / ARCHIVE / DELETE / NOOP
                       │
                       ▼
                  Memory Store
```

Memory Recall 采用：

```text
Global Memory
→ 少量 active Memory 直接加载

Course / Topic Memory
→ Metadata Filter
+ SQLite FTS
+ BGE-M3 Semantic Similarity
+ Importance
+ Confidence
+ Recency
```

Preference、Study Progress、Weakness 和 Study Strategy 使用 canonical current state。

Learning Episode 保存具有长期参考价值的具体学习经历，并通过 active / archived 生命周期管理。

------

# 12. Memory 数据模型

Memory 的核心字段包括：

```text
memoryId
memoryKey
kind

scope
course
topic

content
status

importance
confidence

sourceType
sourceSessionId

createdAt
updatedAt
lastConfirmedAt
lastAccessedAt
accessCount
```

其中：

```text
memoryKey
→ Preference / Progress / Weakness / Strategy 的 canonical identity

scope
→ global / course / topic

status
→ active / resolved / archived
```

第一阶段存储：

```text
SQLite
```

跨 Session 统一通过：

```text
MemoryService
```

提供：

```text
recall(...)
observe(...)
manage(...)
forget(...)
```

具体 Schema、UPDATE、RESOLVE、ARCHIVE、DELETE 和 embedding 生命周期参考：

```text
[Memory 设计补充](./Monash_Study_Agent_Memory_设计补充.md)
```

------

# 13. Local Course Library

课程原始资料作为知识来源。

例如：

```text
Course Library/
│
├── FIT2014/
├── FIT2102/
├── FIT2109/
└── ETW2001/
```

来源包括：

```text
Moodle Downloader
Ed Downloader
本地课程资料
```

项目通过：

```text
config/sources.yml
```

注册课程路径。

------

# 14. Resource Model

所有课程文件统一描述为：

```text
Resource
```

例如：

```json
{
  "resourceId": "FIT2014-W05-parser",
  "course": "FIT2014",
  "week": 5,
  "title": "Parser",
  "source": "moodle",
  "resourceType": "lesson",
  "fileType": "markdown",
  "path": "...",
  "sha256": "..."
}
```

主要字段：

```text
resourceId
course
week
title
source
resourceType
fileType
path
modifiedAt
sizeBytes
sha256
```

第一阶段通过：

```text
resourceId
+
SHA-256
```

判断资源身份与内容变化。

------

# 15. Resource Catalog

Resource Catalog 保存课程资源结构与处理状态。

第一阶段可以保存：

```text
Resources
Normalization State
Index State
```

基本关系：

```text
Raw Files
= 原始内容

Resource Catalog
= 内容身份与状态

Normalized Content
= RAG 输入

LightRAG
= Retrieval Index
```

------

# 16. Normalization Layer

课程资料统一进入：

```text
Resource
↓
NormalizationService
↓
NormalizedDocument[]
```

统一数据结构：

```text
documentId
resourceId
sourceHash

title
course
week
source

contentType
text

sourcePath
locator

normalizationVersion
normalizedHash
```

------

# 17. Normalization 文件支持

第一版支持：

```text
Markdown
QMD
TXT
Code
CSV
Ed Discussions JSON
PDF
DOCX
PPTX
```

## Markdown / Text

直接读取正文。

## Code

保留原始代码文本。

## Ed Discussions

采用：

```text
One Thread
=
One NormalizedDocument
```

保留：

```text
Title
Original Post
Answers
Replies
Author
Role
Timestamp
Accepted Answer
Source
```

## PDF / Office

使用：

```text
Docling
```

统一处理：

```text
PDF text
OCR
layout
tables
image text
DOCX
PPTX
```

生成结果统一进入：

```text
NormalizedDocument
```

------

# 18. Normalized Content

Normalize 后的结果保存到：

```text
data/normalized/
```

例如：

```text
data/normalized/
├── FIT2014/
├── FIT2102/
├── FIT2109/
└── ETW2001/
```

内容格式优先采用：

```text
Markdown
Text
```

方便：

```text
Debug
人工检查
LightRAG ingestion
```

------

# 19. Knowledge Service

Knowledge Service 负责：

```text
Normalization
Document Parsing
LightRAG Ingestion
LightRAG Query
Index Management
Resource → Document Mapping
Evidence Construction
```

推荐运行：

```text
Python Knowledge Service
```

TypeScript Agent 层通过稳定 Service Interface 调用。

基本接口：

```text
normalize_resource(...)
index_resource(...)
search_knowledge(...)
get_resource(...)
```

------

# 20. LightRAG

LightRAG 是课程知识 Retrieval Engine。

负责：

```text
Document Indexing
Chunk Retrieval
Entity Extraction
Relationship Extraction
Vector Retrieval
Graph Retrieval
Context Retrieval
```

Agent 主要通过：

```text
search_knowledge()
```

调用。

例如：

```text
search_knowledge(
    course="FIT2014",
    query="relationship between DFA NFA and regular expressions"
)
```

------

# 21. Evidence Layer

所有 Knowledge Retrieval 最终统一转换为：

```text
Evidence
```

例如：

```json
{
  "evidenceId": "...",
  "resourceId": "...",
  "course": "FIT2014",
  "title": "Week 5 Lecture",
  "excerpt": "...",
  "locator": {
    "path": "...",
    "section": "Regular Languages"
  }
}
```

Evidence 是：

```text
Retrieval
↓
Generation
```

之间的标准接口。

------

# 22. Retrieval Workflow

普通课程问题：

```text
User
 ↓
Main Study Agent
 ↓
Memory Recall
 ↓
search_knowledge
 ↓
LightRAG
 ↓
Evidence
 ↓
DeepSeek
 ↓
Answer
```

Harness Agent Loop 可以根据模型判断继续进行：

```text
再次 search_knowledge
```

或者：

```text
生成最终回答
```

------

# 23. Multi-Agent Research Workflow

复杂问题：

```text
User
↓
Main Study Agent
↓
Research Task
↓
Research Subagent
↓
search_knowledge
↓
Evidence
↓
继续检索
↓
Research Result
↓
Main Study Agent
↓
Memory Context
+
Research Result
↓
Strong DeepSeek Model
↓
Answer
```

------

# 24. 示例：考试复习

用户：

```text
帮我准备 FIT2014 Mid-sem。
```

流程：

```text
Main Study Agent
        ↓
读取 Memory
        ↓
发现：
用户 DFA/NFA 较弱
        ↓
spawn Research Subagent
        ↓
Research Subagent
        │
        ├─ 搜索考试相关资料
        ├─ 搜索 Week 1–7
        ├─ 搜索 Tutorial
        ├─ 搜索 Discussions
        └─ 整理 Evidence
        ↓
Main Study Agent
        ↓
结合：
Research Result
+
Student Memory
        ↓
DeepSeek
        ↓
生成个性化 Revision Plan
```

这构成 V3.0 最重要的 Demo Workflow。

------

# 25. 数据 Source of Truth

项目的数据关系：

```text
Level 1
Raw Course Files

        ↓

Level 2
Resource Catalog

        ↓

Level 3
Normalized Content

        ↓

Level 4
LightRAG Index

        ↓

Level 5
Evidence

        ↓

Level 6
Agent Answer
```

同时：

```text
Student Memory
```

作为独立状态体系存在。

因此：

```text
Course Knowledge
和
Student State
```

拥有独立生命周期。

------

# 26. 手动 Knowledge Update

第一阶段采用简单的手动更新流程：

```text
运行 Downloader
↓
扫描 Resource
↓
Normalization
↓
LightRAG Index
```

例如：

```text
sync source
↓
scan
↓
normalize
↓
index
```

这样能够快速保证：

```text
课程资料真实进入 RAG
```

后续可以把这些步骤进一步自动化。

------

# 27. SQLite

SQLite 第一阶段承担：

```text
Resource State
Normalization State
Index State
Long-term Memory
```

当前运行时数据库：

```text
data/runtime/monash-study-agent.sqlite
```

SQLite 中继续保存现有 Resource / Normalization / LightRAG 状态。

Memory Layer 增加：

```text
memories
memory_embeddings
memory_events
```

第一阶段重点保证：

```text
状态能够持久化
重启以后能够恢复
跨 Session Memory 能够 Recall
Canonical Memory 能够 UPDATE
Weakness / Episode 能够进入对应生命周期
Memory content 与 embedding 保持一致
```

Memory 的详细 Schema 与事务规则统一参考：

```text
[Memory 设计补充](./Monash_Study_Agent_Memory_设计补充.md)
```

------

# 28. Study Controller

Study Controller 保持为业务协调层。

第一阶段职责：

```text
Current Course Context
Memory Service Interface
Knowledge Service Interface
DecisionProvider Interface
ModelPolicy Interface
Agent Tool Registration
```

Controller 保持轻量。

具体 Agent Loop 由：

```text
DeepSeek Harness
```

执行。

这样形成：

```text
Harness
= Runtime orchestration

Study Controller
= Study domain coordination
```

------

# 29. StudyRun

可以保留简单的：

```text
StudyRun
```

记录一次学习请求的核心信息。

例如：

```json
{
  "runId": "...",
  "query": "...",
  "course": "FIT2014",
  "model": "fast",
  "toolsUsed": ["search_knowledge"],
  "evidenceIds": ["..."],
  "subagentsUsed": [],
  "status": "completed"
}
```

复杂 Trace 可以后续逐步扩展。

------

# 30. UI

UI 放在核心 Agent Workflow 完成以后实现。

第一阶段 UI 重点展示：

```text
Chat
Course Selector
Answer
Evidence
Agent Activity
```

例如：

```text
┌──────────────┬──────────────────────────────┐
│ Courses      │ FIT2014                      │
│              │                              │
│ FIT2014      │ User: Explain DFA and NFA    │
│ FIT2102      │                              │
│ FIT2109      │ Agent: Searching course...   │
│              │                              │
│              │ ✓ Week 3 Lecture             │
│              │ ✓ Tutorial 3                 │
│              │                              │
│              │ Answer: ...                  │
└──────────────┴──────────────────────────────┘
```

------

# 31. UI 技术栈

最终 UI 技术栈：

```text
React
TypeScript
Tailwind CSS
shadcn/ui
```

桌面端：

```text
Electron
electron-vite
electron-builder
```

第一阶段优先实现简单：

```text
Chat
Course Selection
Evidence Panel
```

后续再扩展：

```text
Knowledge
Memory
Agent Activity
Settings
Course Dashboard
```

------

# 32. Runtime State

状态 Owner 分层：

## Harness

负责：

```text
Session
Conversation
Tool Call
Subagent
Model Runtime
```

## Monash Study Agent

负责：

```text
Selected Course
StudyRun
Evidence
Resource State
Index State
```

## Memory Service

负责：

```text
Long-term Student Memory
Memory Scope
Memory Lifecycle
Memory Retrieval
Memory Embedding
Memory Event History
```

## Knowledge Service

负责：

```text
Normalized Content
LightRAG
Knowledge Index
```

每种状态保持明确 Owner。

------

# 33. Resume MVP 完整流程

Resume MVP 最终需要真实跑通：

```text
User
↓
React / Electron
↓
Main Study Agent
↓
DeepSeek Harness Agent Loop
↓
Load Global Memory
↓
Recall Course / Topic Memory
↓
search_knowledge
↓
LightRAG
↓
Evidence
↓
必要时 Research Subagent
↓
DeepSeek
↓
Answer
↓
Post-turn Observation
↓
Candidate Extraction
↓
Memory Resolution
↓
Memory Update
```

对话过程中同时存在 Agent-controlled 路径：

```text
Main Study Agent
↓
manage_memory
↓
Memory Service
```

`manage_memory` 与 Post-turn Observation 在 Memory Service 内共享统一的 Resolution 与 Lifecycle 流程。

------

# 34. Resume MVP 技术栈

完成后项目真实覆盖：

```text
TypeScript
Python

DeepSeek Harness
DeepSeek

Agent Tool Calling
Multi-Agent / Subagent
Long-term Memory

RAG
LightRAG
Graph Retrieval
Vector Retrieval

Docling
OCR
Document Normalization

SQLite

React
Tailwind CSS
shadcn/ui

Electron
electron-vite
electron-builder
```

------

# 35. 第一阶段开发顺序

开发顺序：

```text
1. Resource Layer
   已有基础

        ↓

2. Normalization
   Docling
   Forum JSON
   Code / Markdown

        ↓

3. LightRAG
   Index
   Search
   Evidence

        ↓

4. SQLite
   Resource State
   Index State

        ↓

5. Long-term Memory
   Memory Store
   Canonical State
   Global / Course / Topic Scope
   Memory Candidate Extraction
   Memory Resolution
   Hybrid Recall
   Memory Lifecycle

        ↓

6. DeepSeek + DSH
   Main Study Agent
   Tools
   Model Policy

        ↓

7. Multi-Agent
   Research Subagent

        ↓

8. End-to-End Demo
   Memory
   RAG
   Subagent
   Answer

        ↓

9. React UI

        ↓

10. Electron Desktop

        ↓

11. README
    Architecture
    Screenshot
    Demo
```

------

# 36. 第一阶段完成标准

项目达到 Resume MVP 时，至少完成以下真实 Demo。

## Demo 1：RAG

```text
User:
DFA 和 NFA 有什么区别？

Agent
↓
LightRAG
↓
真实课程 Evidence
↓
Answer
```

## Demo 2：Long-term Memory

Session A：

```text
User:
我 Pumping Lemma 掌握得不好。
```

系统写入 Memory。

Session B：

```text
User:
帮我安排 FIT2014 复习。
```

系统 Recall：

```text
Pumping Lemma weakness
```

并调整复习内容。

## Demo 3：Multi-Agent

```text
User:
帮我全面复习 FIT2014 Mid-sem。
```

流程：

```text
Main Agent
↓
Research Subagent
↓
多次 RAG
↓
Research Result
↓
Main Agent
↓
Final Revision Plan
```

## Demo 4：Desktop

```text
Electron App
↓
选择课程
↓
输入问题
↓
看到 Agent Activity
↓
看到 Evidence
↓
看到 Answer
```

------

# 37. 后续迭代方向

Resume MVP 完成以后，可以逐步加强：

```text
TypeSafe JEV Decision Layer

Advanced Memory Evaluation

Automatic Study Strategy Derivation

Adaptive Memory Ranking / Decay

Advanced Memory Consolidation

更多 Subagent

复杂 Evidence Evaluation

Live Ed / Moodle Query

Automatic Knowledge Sync

VLM Document Understanding

Advanced Evaluation

完整 Trace

更完整 Desktop UI

Course Dashboard

Knowledge Visualization
```

这些能力继续建立在当前：

```text
Harness
Memory
Multi-Agent
RAG
Knowledge Service
Evidence
```

架构之上。

------

# 38. 最终核心结构

V3.0 可以概括为：

```text
                    Monash Study Agent
                           │
                           ▼
                         UI
                           │
                           ▼
                  DeepSeek Harness
                           │
                           ▼
                   Main Study Agent
                           │
          ┌────────────────┼────────────────┐
          ▼                ▼                ▼
       Memory            Tools          Subagents
          │                │                │
          ▼                │                │
   Memory Service    search_knowledge   Research Agent
          │                │                │
       SQLite              ▼                │
                   Knowledge Service       │
                           │                │
                        LightRAG            │
                           │                │
                       Evidence ◄───────────┘
                           │
                           ▼
                       DeepSeek
                           │
                           ▼
                         Answer
```

------

# 39. V3.0 核心方向

项目当前开发重点集中在：

```text
RAG
+
Long-term Memory
+
Multi-Agent
+
DeepSeek Harness
+
DeepSeek
+
真实课程资料
```

产品工程层围绕这些核心能力逐步补充：

```text
Normalization
Resource Catalog
SQLite
React UI
Electron Desktop
```

最终形成一个：

> 能够读取真实大学课程资料、建立课程知识库、跨 Session 记忆学生状态、通过 Main Agent 和 Research Subagent 协作完成复杂学习任务，并通过桌面 UI 提供交互的本地学习 Agent。
