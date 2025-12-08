## cursor-agents Testing Master Plan

### 1. Scope & Goals

- **Scope**: `virtual-assistant/cursor-agents` (Express API, BullMQ queue manager, MCP server, task operator, SQLite/Redis integration).
- **Primary goals**:
  - **Reliability**: agents, prompts, and the task operator run continuously and recover from Redis/SQLite/network failures.
  - **Correctness**: HTTP APIs, MCP tools, and internal services behave as specified (status codes, payloads, side effects).
  - **Safety**: distributed lock semantics and task retries do not lose or double-process tasks.
  - **Maintainability**: consistent test patterns that make it easy to extend coverage as new features are added.

### 2. Test Architecture & Conventions

- **Framework**: Jest with `ts-jest` (ESM) and central setup in `tests/setup.ts`.
- **Existing layout** (keep as canonical):
  - **Unit**:
    - `tests/queue/queue-manager.test.ts` – BullMQ queue orchestration.
    - `tests/queue/prompt-processor.test.ts` – HTTP agent and prompt processing.
    - `tests/mcp/server.test.ts` – MCP tools and handlers.
  - **HTTP-level / integration**:
    - `tests/app.test.ts` – Express API endpoints with mocked `QueueManager`.
    - `tests/integration.test.ts` – higher-level workflows (agent lifecycle, queue listing).
- **Test types** (how we’ll use them):
  - **Unit (white-box)**: exercise individual classes/functions (`QueueManager`, `PromptProcessor`, `DatabaseService`, `TaskOperatorService`, `MCPServer` internals) with heavy mocking of I/O and explicit assertions on branches and error handling.
  - **Service integration**: run services with real collaborators but mocked external systems (e.g., real `QueueManager` + `PromptProcessor` with fake Redis/BullMQ/SQLite/fetch) to validate cross-class behavior.
  - **HTTP/API black-box**: use `supertest` against `CursorAgentsApp` to assert status codes, response shapes, and side effects without depending on implementation details (routes are treated as contracts).
  - **MCP black-box**: drive `MCPServer` via its public tool/resource interface (SDK-level calls) and assert only on returned MCP payloads and side effects on queues, not on internal methods.
  - **Process / E2E-lite**: spawn compiled entrypoints (`src/index.ts`, `src/mcp/index.ts`) in a controlled environment to validate startup/shutdown behavior and basic health, without involving real external services.
- **Conventions / improvements**:
  - Prefer **constructor injection** for `QueueManager`, `DatabaseService`, and `TaskOperatorService` where practical to keep tests fast and deterministic.
  - Use **typed Jest mocks** (`jest.Mocked<T>`) for Redis, BullMQ, SQLite, and `fetch`.
  - Group tests by **behavioral contracts** (e.g., “task operator lock semantics”) rather than by method name only.
  - Tag heavier suites with comments like `// Slow / integration` so CI can choose to split test runs if needed.

### 3. Application Lifecycle & Bootstrap (`src/index.ts`, `src/mcp/index.ts`)

- **Objectives**:
  - App and MCP server start correctly with environment variables.
  - Graceful shutdown on `SIGINT`/`SIGTERM` does not hang or leak resources.
- **Planned tests** (process-level, optional but recommended):
  - **Node entrypoint (`src/index.ts`)**:
    - Spawn compiled entrypoint with a test Redis URL and short-lived port.
    - Assert:
      - Logs include “Cursor Agents application started” (or similar console output).
      - Process exits with code `0` after sending `SIGTERM` / `SIGINT`.
      - On startup failure (e.g., Redis unavailable), process exits with non-zero code and logs error.
  - **MCP entrypoint (`src/mcp/index.ts`)**:
    - Happy path: mocked Redis + `QueueManager` so `main()` resolves and logs that MCP server started.
    - Failure path: Redis connectivity error causes logged failure and `process.exit(1)`.
  - Keep these tests behind a separate npm script (e.g., `test:entrypoints`) if they are slower or depend on local ports.

### 4. HTTP Server & API Surface (`src/app.ts`)

- **Objectives**:
  - Every public endpoint has explicit tests for success and failure paths.
  - JSON shapes, status codes, and key side effects (queue/database changes) are enforced.
- **Existing coverage (keep and refine)**:
  - `GET /health` – basic “status: ok” and `service: cursor-agents`.
  - `GET /queues` – happy path + error path when `QueueManager.listQueues` rejects.
  - `/prompts/recurring` – happy path, validation error (missing fields), and queue error.
  - `GET /prompts/:name` – found, not found, and error paths.
  - `DELETE /prompts/:name` – happy path and error path.
  - Bull Board mounting at `/admin/queues`.
  - Initialization/shutdown interaction with `QueueManager.initialize` / `shutdown`.
- **New / improved tests to add**:
  - **Bull Board base path & refresh**:
    - `BULL_BOARD_BASE_PATH`:
      - When set (e.g., `/agents/admin/queues`), verify `ExpressAdapter.setBasePath` is called with that value.
      - Ensure `/admin/queues` route still responds (HTML / 200).
    - `POST /admin/queues/refresh`:
      - Happy path: `updateBullBoard` is called and response includes `success: true` and a `queueCount` matching `queueManager.getQueues().length`.
      - Error path: simulate an exception thrown from `updateBullBoard` (e.g., via a spy) and assert 500 with `error: 'Failed to refresh Bull Board'`.
  - **Queue management**:
    - `GET /queues/:queueName`:
      - Queue exists ⇒ 200 with queue info from `QueueManager.getQueueInfo`.
      - Queue missing (`null`) ⇒ 404 with `error: Queue "<name>" not found`.
      - Internal error ⇒ 500 with `error: 'Failed to get queue info'`.
    - `DELETE /queues/:queueName`:
      - Happy path: verifies `QueueManager.deleteQueue` called and JSON `{ success: true, message: ... }`.
      - Queue not found ⇒ `deleteQueue` throws specific error; assert 500 JSON with error message propagated.
  - **Agent management**:
    - `POST /agents`:
      - Validation:
        - Missing `name` or `targetUrl` ⇒ 400 with `error: 'Missing required fields: name, targetUrl'`.
        - `oneTime=false` and no `schedule` ⇒ 400 with `error` about needing one or the other.
      - Happy paths:
        - One-time agent: `oneTime: true` ⇒ `QueueManager.addOneTimeAgent` is invoked with default method `POST`, default timeout `30000`, and default queue `'default'` when `queue` omitted.
        - Recurring agent: `oneTime: false` and `schedule` provided ⇒ `QueueManager.addRecurringAgent` invoked with correct fields.
      - Error path: when underlying queue method rejects, API returns 500 with `error: 'Failed to create agent'`.
    - `GET /agents`:
      - With multiple queues: `listQueues` returns `[q1, q2]`; `getAgentStatus` returns objects or `null`. Response filters out `null` agents.
      - Error path: `listQueues` rejects ⇒ 500 with `error: 'Failed to list agents'`.
    - `GET /agents/:name`:
      - Agent exists ⇒ status JSON from `QueueManager.getAgentStatus`.
      - Not found (`null`) ⇒ 404 with `error: Agent "<name>" not found`.
      - Error path: exception ⇒ 500 with `error: 'Failed to get agent status'`.
    - `DELETE /agents/:name`:
      - Happy path: calls `QueueManager.removeAgent` and returns success message.
      - Error path: underlying error ⇒ 500 with `error: 'Failed to delete agent'`.
  - **Task operator management**:
    - `POST /task-operator`:
      - Happy path:
        - Mocks `DatabaseService.setSystemSetting` to return `true` and `QueueManager.addOneTimeAgent` to resolve.
        - Verifies one-time agent scheduled into `queue` (default `'task-operator'`).
      - System setting failure:
        - `setSystemSetting` returns `false`, but agent is still enqueued (logs warning).
        - Response still `success: true` with agent info.
      - Queue errors: `addOneTimeAgent` rejects ⇒ 500 with `error: 'Failed to enqueue task operator'`.
    - `DELETE /task-operator`:
      - Happy path:
        - `setSystemSetting('task_operator', false)` returns `true`.
        - `QueueManager.removeAgent('task-operator')` resolves or throws “not found” (which is ignored).
        - Response: `success: true` and message about stopping re-enqueueing.
      - DB failure: `setSystemSetting` returns `false` ⇒ 500 with `error: 'Failed to disable task operator'` and no calls to `removeAgent`.
      - Error path: unexpected exception ⇒ 500 with `error: 'Failed to disable task operator'`.
  - **Task operator lock endpoints**:
    - `GET /task-operator/lock`:
      - Happy path: mocks `TaskOperatorService.getInstance` and `isProcessing()` to return both `true` and `false`, verifying shape and message.
      - Error path: `isProcessing` throws ⇒ 500 with `error: 'Failed to check task operator lock status'`.
    - `DELETE /task-operator/lock`:
      - `clearLock()` returns `true` and `false` respectively; test both responses (`lockCleared` true/false with appropriate message).
      - Error path: `clearLock` throws ⇒ 500 with `error: 'Failed to clear task operator lock'`.
  - **Task operator callback endpoint**:
    - Authentication:
      - With `WEBHOOK_SECRET` set:
        - Missing/incorrect secret in headers/query ⇒ 401 with `error: 'Unauthorized'` and logs a warning.
        - Correct secret ⇒ proceeds to body validation.
      - Without `WEBHOOK_SECRET` set ⇒ no secret required.
    - Validation:
      - Missing `requestId`/`request_id` ⇒ 400 with `error: 'requestId is required'` and a warning log.
    - Happy path:
      - Mocks `TaskOperatorService.getInstance().handleCallback` to resolve; ensures it is invoked with requestId and body, and response is always 200 with `{ received: true, requestId }`.
    - Internal error:
      - When `handleCallback` throws, still returns `200` with `{ received: true, error: 'Internal error processing callback' }` and logs the failure.

### 5. Queue Management & BullMQ (`QueueManager` in `src/queue/queue-manager.ts`)

- **Objectives**:
  - Capture behavior for queue discovery, lifecycle, and safeguards (default queue, empty queue cleanup).
  - Ensure “task-operator” queue semantics (concurrency 1, no duplicate jobs) are enforced.
- **Existing coverage** (to keep):
  - Redis `initialize` and error path.
  - `addRecurringPrompt` (creation of queue, worker, events, and job).
  - `addOneTimeAgent` and `addRecurringAgent` (basic job addition and configuration).
  - `getPromptStatus` (active vs non-existent).
  - `removeRecurringPrompt` (repeatable removal and closures).
  - `listQueues`, `getQueues`, and `shutdown`.
- **New tests to add / improve**:
  - **Redis scan-based queue discovery (`loadExistingQueues`)**:
    - Simulate Redis `scan` returning meta/wait/delayed/active keys for multiple queues, ensure:
      - Each queue is reconstructed via `queueFactory` and workers/events are created with concurrency rules.
      - Errors from rebuilding a particular queue log but do not abort others.
      - If `scan` throws entirely, app logs error and continues (no throw).
  - **`getOrCreateQueue` behavior**:
    - When called with a new queue name:
      - Creates queue instance, worker, and queue events.
      - Uses concurrency `1` for `'task-operator'` and default for other queues.
      - Attaches event handlers (`completed`, `failed`, `active`) without throwing.
    - When called again with same queue:
      - Does not recreate worker/events (idempotence).
  - **Delayed and recurring agents**:
    - `hasExistingJobs`:
      - With waiting/active/delayed jobs for an agent; verify log contents and returned boolean.
      - `excludeActive: true` respects the flag and ensures active jobs are ignored.
      - Error from BullMQ methods ⇒ logs error and returns `false` to avoid blocking re-enqueue.
    - `addDelayedAgent`:
      - Non-task-operator:
        - Creates delayed job with correct `delay` and job data.
      - Task-operator-specific behavior:
        - When `hasExistingJobs` returns `true` ⇒ returns `null` and logs skip.
        - When `hasExistingJobs` returns `false` ⇒ enqueues delayed agent and returns job info.
    - `addRecurringAgent`:
      - Already mostly covered; add edge-case test where `removeRepeatableByKey` throws but is ignored.
  - **Agent status and removal**:
    - `findAgentQueue`:
      - When agent is configured only via repeatable job ⇒ finds correct queue.
      - When there are only waiting/active/completed jobs with `agentName` in job data ⇒ also finds queue.
    - `getAgentStatus`:
      - Non-existent agent ⇒ `null`.
      - One-time job vs recurring job:
        - Confirms `isActive` and `nextRun` logic.
      - Schedules inferred from `repeatableJob.pattern`.
    - `removeAgent`:
      - Removes repeatable job, waiting, and delayed jobs for target agent (with error resilience on removal).
      - Ensures `checkAndCleanupEmptyQueue` is called and may delete now-empty queues (except default).
  - **Queue deletion and cleanup**:
    - `checkAndCleanupEmptyQueue`:
      - When queue is empty and not default ⇒ calls `deleteQueue`.
      - When queue has jobs or is default ⇒ does nothing.
    - `deleteQueue`:
      - Throws if queue not known or if it is the default queue.
      - Throws if any job counts or repeatable jobs are non-zero.
      - On success, closes worker, events, queue, and removes from internal maps.

### 6. Prompt & Agent Processing (`PromptProcessor` in `src/queue/prompt-processor.ts`)

- **Objectives**:
  - Harden HTTP agent and prompt flows, plus internal task-operator wiring and conditional re-enqueueing.
- **Existing coverage** (retain):
  - HTTP agent jobs:
    - GET/POST with headers and body.
    - HTTP error, network error, timeout, JSON and non-JSON responses.
  - Prompt jobs:
    - Happy path calling `/cursor/execute`.
    - Cursor-runner HTTP errors and network errors are logged but do not throw.
    - Default branch handling when not provided.
- **New tests to add**:
  - **Conditional re-enqueueing via response body**:
    - When response is JSON with `{ requeue: true, delay: 5000, condition: '...' }` and `queueManager` is present:
      - `QueueManager.addDelayedAgent` called with the same agent config and `delay: 5000`.
      - Logging includes condition.
    - When response has `requeue: false` or missing ⇒ no re-enqueue.
  - **Task operator internal jobs (`task-operator://internal`)**:
    - Basic path:
      - With `TaskOperatorService.isTaskOperatorEnabled()` returning `false` ⇒ logs and returns without calling `processNextTask` or re-enqueueing.
      - When enabled:
        - If `processNextTask` returns `{ processed: true, taskId }`, re-enqueues agent with a 5s delay (`addDelayedAgent` called once).
        - If result `{ processed: false, reason: 'lock_held' }` ⇒ logs debug and re-enqueues with 5s delay.
        - If result `{ processed: false, reason: 'no_tasks' }` ⇒ logs info and re-enqueues with 5s delay.
    - Error handling:
      - When `processNextTask` throws ⇒ logs error and re-enqueues with 10s delay.
      - When `addDelayedAgent` returns `null` ⇒ logs that re-enqueue was skipped.

### 7. Database & Task Operator Services (`DatabaseService`, `TaskOperatorService`)

- **Objectives**:
  - Enforce task lifecycle, status transitions, and Redis lock semantics for the distributed task operator.
- **New unit test suites to add** (major current gap):
  - **`DatabaseService`**:
    - Connection behavior:
      - Successful connection establishes WAL mode and logs.
      - Connection failure logs and rethrows.
    - `isSystemSettingEnabled`:
      - Returns `false` for missing setting or when query throws (logging error).
      - Returns `true` when row has `value = 1`, `false` for `0`.
    - `setSystemSetting`:
      - Inserts and updates using `ON CONFLICT`, logs success.
      - Simulate write error and assert method returns `false` and logs error.
    - `getNextReadyTask`:
      - Returns `null` when no tasks; returns smallest `"order", id` with `status IN (0,4)` when present.
      - Error path returns `null` and logs.
    - `updateTaskStatus`:
      - With and without `updatedat` column:
        - Adds column when missing; handles race where column already exists.
      - Logs warning when `complete` column is still present.
      - Returns `true` when update changes a row, `false` otherwise.
    - `getTaskStatus` and `markTaskComplete` happy and error paths.
  - **`TaskOperatorService`**:
    - `isTaskOperatorEnabled` delegates to `DatabaseService.isSystemSettingEnabled('task_operator')`.
    - `processNextTask`:
      - Lock acquisition:
        - When lock already held (Redis `set NX` not OK) ⇒ returns `{ processed: false, reason: 'lock_held' }` and logs holder/TTL.
      - No tasks:
        - `getNextReadyTask` returns `null` ⇒ releases lock and `{ processed: false, reason: 'no_tasks' }`.
      - Happy path:
        - Next task available ⇒ status updated to `STATUS_IN_PROGRESS`, new conversation created, pending task stored, request sent to `/cursor/iterate/async`.
        - Handles non-JSON responses from cursor-runner as errors that reset the task to ready and release the lock.
      - Failure paths:
        - Conversation creation fails twice ⇒ marks task back to ready, releases lock, and returns `reason: 'error'`.
        - HTTP error from cursor-runner ⇒ cleans up pending task, resets status to ready, releases lock.
    - `handleCallback`:
      - Unknown `requestId`:
        - With lock belonging to different PID ⇒ clears lock via `clearLock`.
        - With no lock or existing pending tasks ⇒ leaves lock alone.
      - Known pending task:
        - `success: true` (or `"true"`) ⇒ calls `markTaskComplete`, removes pending, and releases lock.
        - `success: false`/undefined ⇒ logs error and sets task back to ready (`STATUS_READY`).
    - `isProcessing` and `clearLock` happy and error paths.
    - Stale task cleanup:
      - Simulate old pending entries exceeding `TASK_TIMEOUT_MS` and ensure:
        - Tasks still `STATUS_IN_PROGRESS` are reset to ready and removed from `pendingTasks`.
        - Tasks already complete are left alone (log only).
        - If all pending tasks are cleared and lock exists ⇒ lock is released.

### 8. MCP Server Layer (`MCPServer` in `src/mcp/server.ts`)

- **Objectives**:
  - Ensure MCP tools and resources provide accurate, stable interfaces for cursor CLI and other MCP clients.
- **Existing coverage**:
  - `create_agent`, `list_agents`, `get_agent_status`, `delete_agent` tools (happy paths and some error cases).
  - Basic `start` and `stop` methods.
- **New tests / refinements**:
  - Tool behavior:
    - Expand tests to assert **exact JSON payloads** returned in `content[0].text` for success/error paths (e.g., error messages and shapes for not-found cases).
    - `list_queues`, `get_queue_info`, and `delete_queue` tools:
      - Happy paths with sample queue metadata.
      - Error conditions when `QueueManager` throws or returns `null` (e.g., queue not found).
  - Agent resources:
    - Resource listing:
      - When `listQueues` returns a set of queue names ⇒ `resources/list` returns a matching array of `agent://{name}` URIs with proper metadata.
    - Resource read:
      - When `getAgentStatus` returns a status, the resource returns JSON text of that status.
      - When `getAgentStatus` returns `null`, handler throws “Agent \<name> not found”.
  - Logging expectations:
    - Where practical, assert that MCP tool invocations log “MCP tool called/completed” with the correct `tool` name and `success` flag (using a mocked logger).

### 9. Integration & E2E-lite Scenarios

- **Objectives**:
  - Validate cross-component workflows without depending on real cursor-runner or external Redis/SQLite by default.
- **Planned scenarios** (extending `tests/integration.test.ts` or new files):
  - **Agent lifecycle with real `QueueManager`** (but mocked Redis, BullMQ, and fetch):
    - Create a recurring agent via `/agents` endpoint and then read its status via `/agents/:name` and MCP `get_agent_status`.
    - Delete the agent via `/agents/:name` and confirm status becomes 404 and queue metadata reflects removal.
  - **Task operator lifecycle (with heavy mocking)**:
    - Use fakes for SQLite and Redis so that:
      - Creating tasks in the DB and enabling task operator leads to jobs being enqueued and processed via mocked cursor-runner.
      - Callbacks received at `/task-operator/callback` mark tasks as complete and release locks.
    - Error scenario where callback never arrives:
      - Force `pendingTasks` to contain stale entries and assert that `cleanupStaleTasks` eventually resets them.
  - **Failure injection**:
    - Simulate Redis down after startup (BullMQ calls rejecting) and verify:
      - Queue endpoints respond with logged errors but do not crash the process.
      - MCP tools surface clear errors when underlying `QueueManager` fails.

### 10. Coverage & CI Strategy

- **Goals**:
  - **Unit coverage**: ≥ 85% for core logic in `queue`, `services`, and `mcp`.
  - **API coverage**: all routes in `src/app.ts` have at least one test asserting status codes and JSON shape.
  - **Error paths**: every meaningful error log line has at least one test exercising it.
- **CI recommendations**:
  - Split test commands into:
    - `npm run test:unit` – unit suites for `queue`, `services`, and `mcp`.
    - `npm run test:http` – `app.test.ts` and HTTP-level integration.
    - `npm run test:e2e-lite` – optional entrypoint and cross-service scenarios.
  - Once new suites are stable, add Jest coverage thresholds in `jest.config.js` for `src/` (excluding entrypoints) to prevent regressions.


