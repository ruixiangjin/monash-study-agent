# Monash Study Agent — Memory 设计补充

> 本文档是 [Monash Study Agent 整体架构设计 V3.0](./Monash%20Study%20Agent%20整体架构设计%20V3.0.md) 的 **Long-term Memory 专项补充**。
> V3.0 继续作为项目整体架构、模块关系、开发顺序与 Resume MVP 的主设计文档。
> 本文档只细化 Memory Layer 的职责、类型、写入、更新、检索、生命周期与测试标准。
>
> **文档状态：Memory 设计基线。** 本文中的 Memory 类型、Scope、策略和 Demo 标准描述设计目标，不应单独当作当前实现或验证证明；当前代码、已实现能力和 smoke 验证范围以 [Codebase Reference](./PROJECT_CODEBASE_REFERENCE.md) 为准。

> **示例说明：** 文中的课程进度、学习困难、对话和 Memory 内容均为虚构示例，不代表任何真实学生记录。

---

# 1. Memory 在整体架构中的位置

Monash Study Agent 的状态分成四个 Owner：

```text
DeepSeek Harness
├── Session
├── Conversation
├── Message History
├── Tool Calls
└── 当前对话上下文

Study Controller / Main Agent
├── Current Course
├── StudyRun
└── 当前任务状态

Memory Service
└── 跨 Session Student Memory

Knowledge Service
└── Course Knowledge / LightRAG
```

因此：

```text
当前 Session 内的连续对话
→ DeepSeek Harness

跨 Session 保留的学生状态
→ Memory Service

课程资料与课程知识
→ Knowledge Service / LightRAG
```

Memory Service 专门解决：

```text
“下一次新 Session 开始时，
Agent 仍然知道这个学生长期稳定的偏好、
当前学习进度、薄弱点、重要学习经历和有效学习策略。”
```

---

# 2. Memory 的认知架构映射

设计参考：

```text
CoALA
MemGPT
Generative Agents
LangMem / LangGraph Memory
Mem0
```

产品层继续使用容易理解的名称：

```text
Preference
Study Progress
Weakness / Mistake
Learning Episode
Study Strategy
```

它们与经典 Memory 分类的大致关系为：

```text
Preference / Study Progress / Weakness
≈ Semantic Memory

Learning Episode
≈ Episodic Memory

Study Strategy
≈ 可跨 Session 使用的 Procedural-style Memory

Current Session Context
≈ Working Memory
```

CoALA 中 Procedural Memory 的范围还包括：

```text
Agent code
Prompt
Tool definitions
Decision procedures
Model parameters
```

Monash Study Agent 当前已经拥有这部分静态 Procedure。

Memory Layer 新增的重点是：

```text
可跨 Session 保存的 Study Strategy
```

例如：

```text
讲 Git 时先画 commit graph，再解释命令。

讲归纳证明时先用中文说明证明思路，
再给出正式英文证明。

代码题采用：
题意翻译 → 自然语言 → 伪代码 → 正式代码。
```

第一阶段将 Study Strategy 表示为结构化数据，并作为 Student Context 提供给 Main Agent。

---

# 3. 五类 Long-term Memory

## 3.1 Preference

保存长期稳定的交互与学习偏好。

例如：

```text
偏好中文解释
偏好先自然语言再代码
偏好简洁回答
复习时偏好先讲知识点再做题
```

特点：

```text
长期稳定
存在明确新偏好时更新当前状态
可以具有 global / course / topic scope
```

---

## 3.2 Study Progress

保存学生当前学习状态。

例如：

```text
FIT2109 Git Week 4 已完成复习
FIT2014 Predicate Logic 已完成第一轮
FIT2102 RxJS 正在复习
```

特点：

```text
表示当前状态
同一 course + topic 使用一个 canonical state
进度变化时更新当前记录
```

例如：

```text
progress:FIT2109:git
```

可以依次经历：

```text
not_started
→ learning
→ reviewed
→ completed
```

数据库中的 active Memory 始终表示最新状态。

---

## 3.3 Weakness / Mistake

保存当前仍然值得关注的薄弱知识点或反复出现的错误。

例如：

```text
DFA / NFA 容易混淆
Git reset / revert 掌握较弱
Pumping Lemma 的反证结构掌握较弱
```

特点：

```text
active
→ 当前仍值得关注

resolved
→ 已经解决
```

当一个 Weakness 被解决：

```text
status = resolved
```

该记录退出正常 Recall 集合，同时保留生命周期信息供 Debug / Trace 使用。

---

## 3.4 Learning Episode

保存值得未来参考的一次具体学习经历。

例如：

```text
2026-09-22：
用户第一次没有理解 fast-forward merge；
改用 commit graph 对比后理解明显改善。
```

或者：

```text
用户在 FIT2014 Mock Test 中连续两次
把 NFA transition 理解错误。
```

Episode 主要用于：

```text
回忆具体学习经历
形成更高层 Weakness
形成更高层 Study Strategy
帮助未来选择更合适的教学方式
```

Episode 使用 append-oriented 生命周期：

```text
active
→ archived
```

active Episode 参与 Recall；archived Episode 保留历史价值并退出常规检索集合。

---

## 3.5 Study Strategy

保存“以后如何更有效地帮助这个学生”的策略。

例如：

```text
Git：
先画 commit graph，再解释 merge / rebase 命令。

Formal Proof：
先解释证明目标，再输出正式英文证明。

代码题：
先解释数据流，再展示完整代码。
```

Study Strategy 作为结构化 Memory 注入 Main Agent Context。

第一阶段重点来源：

```text
用户明确表达的方法偏好
+
具有充分重复证据的学习方式
```

第一轮实现可以优先支持用户明确表达的 Strategy。

---

# 4. Memory Scope

`kind` 表示“这是什么记忆”。

`scope` 表示“这条记忆在什么范围内有效”。

第一版使用：

```text
global
course
topic
```

---

## 4.1 Global Scope

判断标准：

> 这条信息是否应该默认影响大多数未来学习对话？

典型 Global Memory：

```text
偏好中文解释
偏好简洁回答
偏好先自然语言再代码
```

例如：

```text
kind = preference
scope = global
memoryKey = preference:explanation-language
content = Prefers Chinese explanations.
```

Global Memory 数量保持精简，并在 Main Agent 构造 Student Context 时优先加载。

---

## 4.2 Course Scope

只在特定课程中具有意义。

例如：

```text
FIT2109 Git 部分已经完成复习
FIT2014 Pumping Lemma 掌握较弱
```

表示为：

```text
scope = course
course = FIT2014
```

---

## 4.3 Topic Scope

只在某个知识点、学习任务或教学场景中具有意义。

例如：

```text
讲 Git 时先使用 commit graph
```

表示为：

```text
scope = topic
topic = git
```

---

## 4.4 Scope Recall 规则

Recall Context 由两部分组成：

```text
少量 active global memories
+
当前 course / topic 的相关 memories
```

因此正常链路是：

```text
User Query
↓
加载 active global memories
↓
识别 course / topic
↓
检索相关 course / topic memories
↓
合并为 Student Memory Context
```

Global Memory 使用直接加载。

Course / Topic Memory 使用相关性检索。

---

# 5. Canonical Current State

以下四类 Memory 表示“当前有效状态”：

```text
Preference
Study Progress
Weakness
Study Strategy
```

它们采用 canonical state 设计。

核心规则：

```text
同一个 memoryKey
最多对应一个 active current state
```

例如：

```text
memoryKey:
preference:explanation-language
```

过去：

```text
bilingual
```

现在：

```text
chinese-only
```

当前 active Memory 更新为：

```text
preference:explanation-language
= chinese-only
```

这样 Main Agent 在 Recall 时只看到当前有效状态。

---

# 6. Active Memory 与 Event History

Memory 数据分成两个用途：

```text
Active Memory Store
→ 给 Agent 使用

Memory Event History
→ 给 Debug / Trace / Audit 使用
```

---

## 6.1 Active Memory Store

保存：

```text
当前有效 Preference
当前 Study Progress
当前 active Weakness
当前 Study Strategy
当前 active Learning Episode
```

只有 Active Memory：

```text
拥有可检索 embedding
参加 semantic retrieval
参加 recall_memory
进入 Main Agent Context
```

---

## 6.2 Memory Event History

记录生命周期事件：

```text
ADD
UPDATE
RESOLVE
ARCHIVE
DELETE
```

第一阶段最小 event 可以保存：

```text
memoryId
operation
timestamp
```

如后续 Debug 需要更强审计能力，可增加变化摘要。

History 的职责是：

```text
解释一条 Memory 如何演变
帮助 Debug
帮助 Trace
```

它作为历史记录存在，与 Agent Recall Index 分离。

---

# 7. Memory Operations

第一阶段定义：

```text
ADD
UPDATE
RESOLVE
NOOP
ARCHIVE
DELETE
```

### ADD

创建新的 canonical Memory 或新的 Episode。

### UPDATE

更新同一个 canonical Memory 的当前值。

主要用于：

```text
Preference
Study Progress
Weakness
Study Strategy
```

### RESOLVE

表示某个当前状态已经完成或问题已经解决。

主要用于：

```text
Weakness
特定 Progress 状态
```

处理结果：

```text
status = resolved
相关 active embedding 移除
记录 RESOLVE event
```

### NOOP

当前对话没有形成值得长期保存的新信息。

### ARCHIVE

主要用于 Learning Episode 生命周期整理。

处理结果：

```text
status = archived
active embedding 移除
记录 ARCHIVE event
```

### DELETE

Hard Delete 用于执行明确的用户删除 / Forget 意图，或经同等强度授权后彻底清理错误数据。

处理结果：

```text
删除 memory
删除 embedding
记录最小 deletion event
```

删除事件保留：

```text
memoryId
operation
timestamp
```

DELETE 使用最高决策阈值。Post-turn Observer 和 `manage_memory` 都可以产生 DELETE candidate，MemoryResolver 只在输入携带明确的用户删除 / Forget 意图时将其执行为 Hard Delete。对过时、低价值或状态变化的判断优先映射为 `UPDATE`、`RESOLVE` 或 `ARCHIVE`。

---

# 8. Memory Write Pipeline

Long-term Memory 使用 **Hybrid Memory Formation**，具有两条 formation path：

```text
Background / Post-turn Formation
→ completed turn 后由系统自动触发

Agent-controlled / Hot-path Formation
→ Main Agent 在对话过程中通过 manage_memory 主动触发
```

两条路径的职责按触发来源与执行时机划分。二者共享同一套 Memory policy 和 persistence pipeline，并都可以形成完整的 lifecycle operation。

```text
Completed Turn                         Main Agent
      │                                  │
      ▼                                  ▼
Post-turn Observation                  manage_memory
      │                                  │
      └─────────────────┬─────────────────┘
                       ▼
                 Memory Candidate
                       │
                       ▼
       Retrieve Related Existing Memories
                       │
                       ▼
                 MemoryResolver
                       │
                       ▼
            MemoryLifecycleManager
                       │
                       ▼
                   MemoryStore
```

MemoryResolver 为两条路径统一决定：

```text
ADD
UPDATE
RESOLVE
ARCHIVE
DELETE
NOOP
```

Post-turn Observer 可以根据 completed turn 产生上述任一 candidate。`manage_memory` 也可以产生同一组 candidate；它们的操作能力一致，由统一 Resolver 、Lifecycle Manager 和 Store 执行相同的决策与持久化规则。

---

# 9. 什么信息进入 Long-term Memory

优先写入：

```text
用户明确要求长期记住的信息
稳定的表达与学习偏好
课程学习状态的明显变化
明确暴露或重复出现的薄弱点
未来具有参考价值的学习 Episode
用户明确表达的 Study Strategy
```

其他对话内容继续由：

```text
Harness Session / Conversation History
```

承担当前 Session 的上下文作用。

课程资料继续由：

```text
Knowledge Service / LightRAG
```

承担知识存储与检索作用。

因此三套状态有清晰分工：

```text
Conversation History
→ 当前 Session

Student Memory
→ 跨 Session 学生状态

Course Knowledge
→ 课程资料与知识
```

---

# 10. Source Priority 与 Confidence

每条 Memory 记录来源：

```text
user_explicit
system_observed
agent_inferred
derived
```

优先级：

```text
user_explicit
>
reliable system / tool observation
>
repeated / derived evidence
>
single agent inference
```

规则：

```text
新的 user_explicit 信息
可以直接更新旧的 user_explicit current state。

system/tool observation
可以更新对应的可客观验证 Progress。

agent_inferred
以较低 confidence 进入候选判断，
由 MemoryResolver 根据证据强度决定写入方式。
```

这使明确用户表达始终拥有最高解释权。

---

# 11. Memory Candidate Extraction

第一版复用：

```text
DeepSeek Flash
```

负责从一次 completed turn 中提取结构化候选。

例如：

```json
{
  "operation": "UPDATE",
  "kind": "preference",
  "scope": "global",
  "memoryKey": "preference:explanation-language",
  "content": "Prefers Chinese-only explanations.",
  "sourceType": "user_explicit"
}
```

Post-turn Observation 与 `manage_memory` 都会构造相同的 `MemoryCandidate` 数据结构。DeepSeek 在需要从自然语言提取候选时负责：

```text
理解自然语言
生成 Memory Candidate
```

MemoryResolver 的职责是：

```text
检查 existing memory
检查 source priority
检查 canonical key
决定最终 operation
```

MemoryStore 的职责是：

```text
执行数据库事务
维护 embedding
写入 memory event
```

---

# 12. Memory Recall

Recall 流程：

```text
User Query
    ↓
Load Global Context
    ↓
Scope Filter
    ↓
Candidate Retrieval
    ↓
Ranking
    ↓
Top Relevant Memories
    ↓
Memory Context
```

---

# 13. Hybrid Retrieval

Course / Topic Memory 使用 Hybrid Recall：

```text
Metadata filtering
+
SQLite FTS / keyword match
+
BGE-M3 semantic similarity
+
Importance
+
Confidence
+
Recency
```

概念上：

```text
Final Recall Score
=
Relevance 为主
+
Importance
+
Confidence
+
Recency / Strength
```

第一版使用一套可解释 heuristic。

后续通过实际 Eval 调整权重。

---

# 14. Global Memory Recall

Global Memory 与普通 Recall 分开处理。

Main Agent 构造 Student Context 时：

```text
1. 直接加载少量 active global Preference
2. 加载需要全局适用的 active Strategy
3. 再执行 course/topic hybrid recall
```

典型 Global Context：

```text
Language preference
Answer style
Explanation style
General study interaction preference
```

这类 Memory 的价值来自“长期默认适用”，因此采用 direct load。

---

# 15. Learning Episode 生命周期

Learning Episode 可以保留多条。

第一版设置：

```text
active Episode limit per course = configurable
```

推荐初始值：

```text
50
```

当 active Episode 超过限制时，根据：

```text
importance
recency
access history
是否已经形成 higher-level memory
```

选出较低价值 Episode：

```text
active
→ archived
```

archived Episode：

```text
保留历史记录
移除 active embedding
退出常规 Recall
```

这个整理动作由新 Episode 写入时触发。

---

# 16. Lightweight Consolidation

多个 Episode 可以逐渐形成更高层 Memory。

例如：

```text
Episode 1：
Git graph 理解困难。

Episode 2：
直接解释命令效果一般。

Episode 3：
commit graph 解释后理解明显改善。
```

可以形成：

```text
Weakness:
Git branch / merge graph understanding 较弱

Study Strategy:
解释 Git merge 时优先使用 commit graph
```

第一阶段 Consolidation 采用轻量方式：

```text
新 Memory 写入
↓
检索少量 related memories
↓
MemoryResolver 比较
↓
必要时 UPDATE / ADD higher-level memory
```

---

# 17. Study Strategy 第一阶段规则

第一轮开发优先支持：

```text
用户明确表达的 Study Strategy
```

例如：

```text
“Git 这种内容以后先给我画图，再讲命令。”
```

形成：

```text
kind = study_strategy
scope = topic
topic = git
memoryKey = strategy:git:visual-first
```

后续增强阶段可以加入：

```text
重复 Episode
+
明确成功反馈
↓
Derived Study Strategy
```

这样 Procedural-style Memory 可以循序渐进增强。

---

# 18. SQLite 设计

继续使用：

```text
data/runtime/monash-study-agent.sqlite
```

最小表：

```text
memories
memory_embeddings
memory_events
```

---

## 18.1 memories

保存 Agent 可使用的 Memory。

核心字段：

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

对于：

```text
Preference
Study Progress
Weakness
Study Strategy
```

`memoryKey` 表示 canonical identity。

同一个 `memoryKey` 对应一个 current record。

Learning Episode 使用独立 `memoryId`。

---

## 18.2 memory_embeddings

保存当前可检索 Memory 的 embedding。

Embedding 来源：

```text
BAAI/bge-m3
```

当 Memory：

```text
UPDATE
```

时写入新 embedding。

当 Memory：

```text
RESOLVE
ARCHIVE
DELETE
```

时移除 active embedding。

---

## 18.3 memory_events

保存：

```text
ADD
UPDATE
RESOLVE
ARCHIVE
DELETE
```

等生命周期事件。

第一阶段最小字段：

```text
eventId
memoryId
operation
timestamp
```

---

# 19. UPDATE 的事务规则

UPDATE 时：

```text
生成新 content
↓
生成新 embedding
↓
embedding 成功
↓
开启 SQLite transaction
↓
UPDATE memory
UPDATE embedding
INSERT memory_event
↓
COMMIT
```

这样 Memory content 与 embedding 始终对应同一个版本。

如果新 embedding 生成失败：

```text
当前 active Memory 继续保持原有有效版本
```

---

# 20. RESOLVE / ARCHIVE 事务规则

```text
BEGIN TRANSACTION
↓
更新 memory.status
↓
删除 active embedding
↓
写入 lifecycle event
↓
COMMIT
```

---

# 21. DELETE 事务规则

MemoryResolver 在确认 candidate 携带明确的用户删除 / Forget 意图后，交由 MemoryLifecycleManager 执行：

```text
BEGIN TRANSACTION
↓
删除 embedding
↓
删除 memory
↓
写入无正文 deletion event
↓
COMMIT
```

用户明确 Forget 后，正文退出所有 Student Memory 存储。

---

# 22. MemoryService

统一接口：

```ts
interface MemoryService {
  recall(query: MemoryRecallQuery): Promise<MemoryContext[]>

  observe(input: MemoryObservation): Promise<MemoryWriteResult>

  manage(command: MemoryCommand): Promise<MemoryWriteResult>

  forget(memoryId: string): Promise<void>
}
```

职责：

```text
recall
→ 构造相关 Student Memory Context

observe
→ 系统在 completed turn 后触发 formation，并将 Memory Candidate 交给统一 resolution pipeline

manage
→ Main Agent 在对话过程中主动触发 formation，并将 Memory Candidate 交给统一 resolution pipeline

forget
→ 为明确的用户删除 / Forget 意图提供直接的 Hard Delete 入口
```

`observe()` 和 `manage()` 共享 `MemoryResolver`、`MemoryLifecycleManager` 与 `MemoryStore`。二者均支持 `ADD / UPDATE / RESOLVE / ARCHIVE / DELETE / NOOP`；DELETE 继续遵循第 7 节与第 21 节的明确用户意图边界。

---

# 23. Memory 内部组件

逻辑组件：

```text
MemoryService
├── MemoryStore
├── MemoryCandidateExtractor
├── MemoryResolver
├── MemoryRetriever
└── MemoryLifecycleManager
```

第一阶段可以保持在同一个 Memory package / service 中。

---

# 24. Agent Tool

后续 Main Agent 集成时提供：

```text
recall_memory
manage_memory
```

Main Agent 可以通过：

```text
manage_memory
```

在对话过程中主动发起 Memory management。系统生命周期则在 completed turn 后通过：

```text
MemoryService.observe()
```

自动发起 Post-turn Memory formation。两个入口都进入统一的 `MemoryResolver → MemoryLifecycleManager → MemoryStore` 流程。

---

# 25. Main Agent Memory Workflow

```text
User → DeepSeek Harness → Main Study Agent
              │
              ▼
      Load Global Memory
              │
              ▼
        recall_memory
              │
              ▼
  Relevant Student Memory
              │
              ▼
      search_knowledge
              │
              ▼
       Course Evidence
              │
              ▼
           DeepSeek
              │
              ▼
            Answer
```

```text
Main Study Agent                      Answer
       │                                 │
       ▼                                 ▼
 manage_memory                    Post-turn Observation
       │                                 │
       └────────────────┬───────────────┘
                        ▼
                  Memory Candidate
                        │
                        ▼
                  MemoryResolver
                        │
                        ▼
             MemoryLifecycleManager
                        │
                        ▼
                   MemoryStore
```

这一工作流将自动的 Post-turn Formation 和 Main Agent 主动的 Hot-path Formation 收敛到同一套 Memory policy 与 persistence pipeline。

---

# 26. Research Subagent Memory Policy

Resume MVP 中：

```text
Main Agent
→ Recall Student Memory
→ 触发 Memory Observation / Management

Research Subagent
→ 接收 Main Agent 提供的相关 Memory Context
→ 专注课程资料研究
```

长期 Memory 写入由 Main Agent 和系统生命周期提供两种触发方式，并统一经过 MemoryService 的 Resolution 与 Lifecycle 规则。

这样所有长期状态共享单一持久化管线与统一 Resolution 规则。

---

# 27. Memory Evaluation

Memory Round 至少验证：

```text
1. 跨 Session Recall 成功

2. 同一个 Preference 重复出现
   → canonical state 保持一条

3. 用户改变 Preference
   → current state 更新
   → Recall 只返回新状态

4. Weakness 被解决
   → status = resolved
   → active embedding 移除
   → Recall 返回集合中不再包含该 Weakness

5. Course Scope 生效
   → 当前课程 Recall 返回相关课程 Memory

6. Topic Scope 生效
   → 当前知识点 Recall 返回相关 Strategy / Weakness

7. Global Preference
   → 新 Session 默认加载

8. Archived Episode
   → 保留历史
   → 退出默认 Recall

9. Study Strategy
   → 匹配 topic 时成功 Recall

10. Explicit Forget
    → memory 与 embedding 删除

11. UPDATE embedding consistency
    → content 与 embedding 始终匹配

12. Memory Event
    → 生命周期变化可追踪
```

---

# 28. Resume MVP Memory Demo

## Demo A：跨 Session Weakness

Session A：

```text
User:
我 Pumping Lemma 掌握得不好。
```

形成：

```text
memoryKey = weakness:FIT2014:pumping-lemma
scope = course
course = FIT2014
status = active
```

Session B：

```text
User:
帮我安排 FIT2014 复习。
```

Recall 返回：

```text
Pumping Lemma weakness
```

Agent据此提高该部分复习优先级。

---

## Demo B：Global Preference Update

Session A：

```text
User:
我喜欢中英双语。
```

形成：

```text
preference:explanation-language = bilingual
scope = global
```

Session B：

```text
User:
以后学习解释只用中文。
```

执行：

```text
UPDATE preference:explanation-language
```

当前状态：

```text
chinese-only
```

Session C 自动加载新的 Global Preference。

---

## Demo C：Topic Strategy

用户：

```text
Git 这种东西以后先给我画图，再讲命令。
```

形成：

```text
strategy:git:visual-first
scope = topic
topic = git
```

新 Session：

```text
User:
再讲一下 rebase。
```

Recall 命中该 Strategy。

Main Agent 使用 commit graph 方式解释。

---

# 29. Memory Round 开发范围

当前项目已经完成：

```text
Resource
Normalization
LightRAG
Incremental Sync
Evidence Retrieval
Architecture Stabilization
Real Retrieval Smoke
```

下一阶段 Memory Round 聚焦：

```text
Memory schema + SQLite migration
Memory domain types
MemoryStore
Canonical UPDATE / RESOLVE / DELETE
Memory Candidate Extraction
MemoryResolver
BGE-M3 Memory Embedding
Hybrid Recall
Global / Course / Topic Scope
Episode Lifecycle
Explicit Study Strategy
Memory Events
Cross-session Memory Smoke
```

Memory Service 独立完成以后，再进入：

```text
DSH Main Study Agent
↓
Memory Tools / Observe Hook
↓
Research Subagent
↓
End-to-End Demo
↓
React UI
↓
Electron
```

---

# 30. Memory 设计核心原则

```text
1. Harness 管当前 Session；
   Memory Service 管跨 Session Student State。

2. Course Knowledge 进入 LightRAG；
   Student State 进入 Memory Service。

3. Preference / Progress / Weakness / Strategy
   使用 canonical current state。

4. 一个 memoryKey 对应一个当前状态。

5. Global / Course / Topic 表示 Memory 的作用范围。

6. Global Memory 采用少量 direct load。

7. Course / Topic Memory 采用 Hybrid Recall。

8. Active Memory 拥有 embedding 并参与 Recall。

9. History 记录生命周期事件并服务 Debug / Trace。

10. UPDATE 同步更新 content 与 embedding。

11. RESOLVE / ARCHIVE 让记录退出 active recall。

12. Explicit Forget 执行 Hard Delete。

13. Episode 保存具体经历，并通过 archive 控制 active 数量。

14. Study Strategy 保存可跨 Session 使用的教学方法。

15. DeepSeek 负责提取 Candidate；
    MemoryResolver 负责最终决策；
    MemoryStore 负责持久化。

16. Memory Recall 使用：
    Metadata + FTS + BGE-M3 + Importance + Confidence + Recency。

17. 所有 Memory 保留清晰的来源、状态、scope 与更新时间。

18. Long-term Memory 使用 Hybrid Memory Formation：
    Background / Post-turn Observation
    +
    Agent-controlled manage_memory。

19. 两条 formation path 的职责按触发来源与时机划分，
    并共享 MemoryResolver、MemoryLifecycleManager 和 MemoryStore。

20. Post-turn Observer 与 manage_memory 均可形成完整的
    ADD / UPDATE / RESOLVE / ARCHIVE / DELETE / NOOP operation；
    Hard Delete 以明确的用户删除 / Forget 意图为执行边界。
```

---

# 31. 本文档与 V3.0 的关系

```text
整体系统架构
→ [Monash Study Agent 整体架构设计 V3.0](./Monash%20Study%20Agent%20整体架构设计%20V3.0.md)

Long-term Memory 详细设计
→ 本文档
```

后续开发时：

```text
整体模块关系、主流程、技术栈、开发顺序
→ 以 V3.0 为基线

Memory schema、scope、写入、更新、Recall、生命周期
→ 以本 Memory 补充为基线
```
