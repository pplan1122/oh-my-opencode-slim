# OMO-slim Hook 参考文档

> 基于 2026-06-25 三方审计（代码 ↔ 文档 ↔ SDK）生成。

## 概述

OMO-slim 通过 OpenCode Plugin SDK 注册了 9 种 hook 协议，覆盖 18 个 handler。所有 hook 在 `src/index.ts:810-1190` 统一编排。

### 执行顺序

```
tool.execute.before
  → apply-patch Hook
  → task-session-manager Hook
  → workflow-planning Hook

tool.execute.after
  → delegate-task-retry Hook
  → json-error-recovery Hook
  → post-file-tool-nudge Hook
  → task-session-manager Hook
  → workflow-planning Hook

experimental.chat.messages.transform
  → display-name rewriter
  → processImageAttachments
  → task-session-manager Hook
  → phase-reminder Hook
  → workflow-planning Hook
  → filter-available-skills Hook
```

---

## Hook 清单

### 1. tool.execute.before

| Handler | 文件 | 用途 |
|---------|------|------|
| `createApplyPatchHook` | `apply-patch/` | 拦截 Write/Edit，将 patch 格式转换 |
| `task-session-manager` | `task-session-manager/` | 管理 task 会话重用、task_id 解析 |
| `workflow-planning` | `workflow-planning/` | 工作流计划步骤匹配 + 上下文注入 |

### 2. tool.execute.after

| Handler | 文件 | 用途 |
|---------|------|------|
| `createDelegateTaskRetryHook` | `delegate-task-retry/` | task 执行失败时的重试引导 |
| `createJsonErrorRecoveryHook` | `json-error-recovery/` | JSON 解析错误恢复 |
| `createPostFileToolNudgeHook` | `post-file-tool-nudge/` | 文件工具操作后的上下文提示 |
| `task-session-manager` | `task-session-manager/` | 注册 task 启动、捕获输出、管理会话状态 |
| `workflow-planning` | `workflow-planning/` | 捕获步骤结果、触发验证提醒 |

### 3. experimental.chat.messages.transform

| Handler | 文件 | 用途 |
|---------|------|------|
| `display-name rewriter` | `index.ts` (inline) | 重写 agent display name mention |
| `processImageAttachments` | `image-hook.ts` | 剥离 orchestrator 消息中的图片附件 |
| `task-session-manager` | `task-session-manager/` | 处理注入的后台任务完成通知 |
| `createPhaseReminderHook` | `phase-reminder/` | 注入工作流阶段提醒 |
| `createWorkflowPlanningHook` | `workflow-planning/` | 检测 JSON 工作流计划 + 注入进度/验证提示 |
| `createFilterAvailableSkillsHook` | `filter-available-skills/` | 按 agent 权限过滤可用 skills 列表 |

### 4. experimental.chat.system.transform

| Handler | 文件 | 用途 |
|---------|------|------|
| orchestrator prompt injection | `index.ts` (inline) | Serve 模式下注入 orchestrator 系统 prompt |

### 5. chat.message

| Handler | 文件 | 用途 |
|---------|------|------|
| session-agent mapping | `index.ts` (inline) | 追踪每个 session 使用的 agent |

### 6. chat.headers

| Handler | 文件 | 用途 |
|---------|------|------|
| `createChatHeadersHook` | `chat-headers.ts` | 注入自定义 HTTP headers |

### 7. event

| Handler | 文件 | 监听事件 | 用途 |
|---------|------|---------|------|
| `ForegroundFallbackManager` | `foreground-fallback/` | `session.error`, `message.updated`, `session.status`, `session.created`, `session.deleted` | 前台 agent 模型降级切换 |
| `createAutoUpdateCheckerHook` | `auto-update-checker/` | `session.created` | 检查插件更新 |
| `task-session-manager` | `task-session-manager/` | `session.created`, `session.idle`, `session.status`, `session.error`, `session.deleted` | 任务生命周期管理 |
| multiplexer manager | `multiplexer/` | `session.idle`, `session.deleted` | 终端窗格清理 |

### 8. command.execute.before

| Handler | 文件 | 用途 |
|---------|------|------|
| `createDeepworkCommandHook` | `deepwork/` | 拦截 `/deepwork` 命令 |
| `createReflectCommandHook` | `reflect/` | 拦截 `/reflect` 命令 |
| interview manager | `interview/` | 拦截 interview 相关命令 |
| preset manager | `tools/preset-manager.ts` | 拦截 `/preset` 命令 |

### 9. config

| Handler | 文件 | 用途 |
|---------|------|------|
| `createDeepworkCommandHook` | `deepwork/` | `/deepwork` 命令的配置回调 |

---

## Agent 权限模型

| Agent | Skill 白名单 |
|-------|-------------|
| orchestrator | `*`（所有 skills） |
| oracle / council / councillor | `simplify` + 9 个 `book-rules/*` + `requesting-code-review` |
| designer | 无（与其他非 orchestrator agent 一样默认 `*` → deny） |
| explorer / fixer / librarian / observer | 无 |

---

## 相关文档

- `docs/background-orchestration.md` — 后台编排架构概念（与本文档的代码映射见该文档末尾）
- `src/hooks/types.ts` — 消息类型定义
