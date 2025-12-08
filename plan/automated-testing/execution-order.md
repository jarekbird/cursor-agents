## cursor-agents Testing Plan – Execution Order

This file turns `master-plan.md` into a **step-by-step execution plan** for an automated agent.  
Follow steps in order; each step should be completed (including adding/updating tests and making them pass) before moving to the next.

> Conventions:  
> - “Add tests” always means: write tests, run Jest, and fix any issues until green.  
> - Prefer updating existing test files when they already cover the component mentioned.

---

### Phase 0 – Baseline & Tooling

1. **Verify existing test commands**
   - Open `package.json` and confirm scripts for running tests (`test`, `test:watch`, `test:coverage` or equivalents).
   - If missing, add standard Jest scripts:
     - `"test": "jest"`
     - `"test:watch": "jest --watch"`
     - `"test:coverage": "jest --coverage"`
   - Run `npm test` once to confirm the current suite passes.

2. **Create/verify logical Jest script groups**
   - In `package.json`, add or confirm:
     - `"test:unit"` – runs only unit-oriented suites (e.g., `tests/queue`, `tests/mcp`, new `tests/services` you will add).
     - `"test:http"` – runs HTTP/API-level suites (`tests/app.test.ts`, `tests/integration.test.ts`).
     - `"test:e2e-lite"` – reserved for future entrypoint/process-level tests.
   - Make sure these scripts use Jest `--runTestsByPath` or `--testPathPattern` filters as appropriate.

3. **Confirm global Jest setup**
   - Open `tests/setup.ts` and verify:
     - Global `fetch` is mocked or polyfilled.
     - Console output suppression works as intended.
   - If any new global concerns are introduced by later steps (e.g., additional globals), update `tests/setup.ts` accordingly.

---

### Phase 1 – DatabaseService Unit Tests

4. **Create a new test file for `DatabaseService`**
   - Create `tests/services/database-service.test.ts`.
   - Import `DatabaseService` from `src/services/database-service.ts`.

5. **Test database connection success**
   - Arrange:
     - Point `DatabaseService` to a temporary SQLite file path (e.g., under `tmp` or an in-memory DB `:memory:` if compatible).
   - Act:
     - Call a simple method (e.g., `isSystemSettingEnabled`) that triggers `getDatabase()`.
   - Assert:
     - No error is thrown.
     - Optional (if you can inspect PRAGMAs): `journal_mode` is set to WAL.

6. **Test database connection failure**
   - Arrange:
     - Construct `DatabaseService` with an invalid/unwritable DB path.
   - Act & Assert:
     - Calling a method that triggers `getDatabase()` throws an error.
     - Ensure the logger receives an error (mock the logger if needed).

7. **Test `isSystemSettingEnabled` behavior**
   - Arrange:
     - Use a test database and create a minimal `system_settings` table.
     - Insert sample rows (`name`, `value`) for at least one setting.
   - Cases:
     - **Setting present, value = 1** ⇒ returns `true`.
     - **Setting present, value = 0** ⇒ returns `false`.
     - **Setting missing** ⇒ returns `false` with no exception.
   - Add a case where the underlying query throws (e.g., table missing) and assert:
     - Method returns `false`.
     - Error is logged.

8. **Test `setSystemSetting` happy path**
   - Arrange:
     - Use a test DB with `system_settings` schema.
   - Act:
     - Call `setSystemSetting('task_operator', true)` then `isSystemSettingEnabled('task_operator')`.
     - Call `setSystemSetting('task_operator', false)` then re-check.
   - Assert:
     - Return value is `true` for both calls.
     - Values in DB correspond to `1` and `0` respectively.

9. **Test `setSystemSetting` error path**
   - Arrange:
     - Mock the underlying database `prepare`/`run` to throw.
   - Act:
     - Call `setSystemSetting(...)`.
   - Assert:
     - Method returns `false`.
     - Error is logged.

10. **Test `getNextReadyTask` behavior**
    - Arrange:
      - Create `tasks` table with fields required by `DatabaseService`.
      - Insert multiple tasks with varying `"order"` and `status` values (0, 1, 2, 3, 4).
    - Cases:
      - No tasks ⇒ returns `null`.
      - Tasks with `status IN (0,4)` present ⇒ returns the one with lowest `"order"` then `id`.
    - Error path:
      - Force an error in the query and assert:
        - Method returns `null`.
        - Error is logged.

11. **Test `updateTaskStatus` with `updatedat` column missing**
    - Arrange:
      - Create `tasks` table initially without `updatedat` column.
      - Insert a single row.
    - Act:
      - Call `updateTaskStatus(taskId, newStatus)` and let it attempt to `ALTER TABLE`.
    - Assert:
      - The call returns `true`.
      - A subsequent query shows the `status` changed.
      - `updatedat` column exists after the call.

12. **Test `updateTaskStatus` when `updatedat` already exists**
    - Arrange:
      - Ensure `tasks` table includes `updatedat`.
    - Act:
      - Call `updateTaskStatus(taskId, newStatus)` again.
    - Assert:
      - No `ALTER TABLE` is attempted (or at least does not throw).
      - `updatedat` changes timestamp (if feasible to assert).

13. **Test `updateTaskStatus` when old `complete` column exists**
    - Arrange:
      - Add a `complete` column to the `tasks` table.
    - Act:
      - Call `updateTaskStatus`.
    - Assert:
      - Method returns `true`.
      - A warning is logged about `complete` column.

14. **Test `getTaskStatus` and `markTaskComplete`**
    - Arrange:
      - Insert a few tasks with differing `status` values.
    - Act & Assert:
      - `getTaskStatus` returns the correct status or `null` when not found.
      - `markTaskComplete(taskId)` changes status to `STATUS_COMPLETE`.

15. **Test `close` behavior**
    - Arrange:
      - Open a DB via any method call.
    - Act:
      - Call `close()` twice.
    - Assert:
      - No exception on second call.
      - Optional: verify via logger that connection close is logged once.

---

### Phase 2 – TaskOperatorService Unit Tests

16. **Create a new test file for `TaskOperatorService`**
    - Create `tests/services/task-operator-service.test.ts`.
    - Import `TaskOperatorService` and `DatabaseService`.
    - Use `TaskOperatorService.resetInstance()` between tests to avoid cross-test state.

17. **Test `isTaskOperatorEnabled` delegation**
    - Mock `DatabaseService` within `TaskOperatorService` to control return values.
    - Assert that `isTaskOperatorEnabled()` simply forwards to `DatabaseService.isSystemSettingEnabled('task_operator')`.

18. **Test lock acquisition failure in `processNextTask`**
    - Mock Redis `set` to return a non-`OK` value.
    - Act:
      - Call `processNextTask()`.
    - Assert:
      - Result is `{ processed: false, reason: 'lock_held' }`.
      - A log entry notes lock holder and TTL.

19. **Test `processNextTask` with no tasks available**
    - Mock Redis `set` to succeed (return `'OK'`).
    - Stub `DatabaseService.getNextReadyTask` to return `null`.
    - Act:
      - Call `processNextTask()`.
    - Assert:
      - Result is `{ processed: false, reason: 'no_tasks' }`.
      - `releaseLock()` is called.

20. **Test happy path `processNextTask`**
    - Arrange:
      - Mock Redis lock acquisition success.
      - Stub `getNextReadyTask` to return a sample task.
      - Stub `DatabaseService.updateTaskStatus` to succeed when marking `STATUS_IN_PROGRESS`.
      - Stub conversation creation (`fetch` to `/cursor/conversation/new`) to succeed and return a `conversationId`.
      - Stub async iterate call (`fetch` to `/cursor/iterate/async`) to succeed with JSON `{ success: true }`.
    - Act:
      - Call `processNextTask()`.
    - Assert:
      - Result is `{ processed: true, taskId: <id> }`.
      - Task is marked in-progress.
      - A `PendingTask` entry is stored for the generated `requestId`.
      - Lock is **not** immediately released (callback will release it).

21. **Test conversation creation failure**
    - Arrange:
      - Make `createNewConversation()` (fetch to `/cursor/conversation/new`) fail twice.
    - Act:
      - Call `processNextTask()`.
    - Assert:
      - Task status is set back to ready (`STATUS_READY`).
      - Lock is released.
      - Result has `processed: false` and `reason: 'error'`.

22. **Test cursor-runner HTTP failure in `processNextTask`**
    - Arrange:
      - Make the async iterate call return a non-OK HTTP status.
    - Act:
      - Call `processNextTask()`.
    - Assert:
      - Pending task for that `requestId` is removed.
      - Task status is set back to ready.
      - Lock is released with `reason: 'error'`.

23. **Test `handleCallback` for unknown `requestId` with foreign lock**
    - Arrange:
      - Leave `pendingTasks` empty.
      - Mock Redis `get` to return a lock value with a different PID than current process.
    - Act:
      - Call `handleCallback('unknown-id', {...})`.
    - Assert:
      - `clearLock()` is called.
      - No DB status changes occur.

24. **Test `handleCallback` success path**
    - Arrange:
      - Seed `pendingTasks` map with one entry (`taskId`, `requestId`).
      - Mock `DatabaseService.markTaskComplete` to return `true`.
      - Mock Redis lock to be owned by current instance.
    - Act:
      - Call `handleCallback(requestId, { success: true, iterations: 3 })`.
    - Assert:
      - Task is marked complete.
      - Pending entry is removed.
      - `releaseLock()` is invoked.

25. **Test `handleCallback` failure path**
    - Arrange:
      - Seed `pendingTasks`.
      - Mock `DatabaseService.updateTaskStatus` to be called with `STATUS_READY` on failure.
    - Act:
      - Call `handleCallback(requestId, { success: false, error: 'boom' })`.
    - Assert:
      - Task is reset to ready.
      - Pending entry is removed.
      - Lock is released.

26. **Test `isProcessing` and `clearLock`**
    - For `isProcessing`:
      - Mock Redis `exists` to return 1 and 0 in different tests; assert boolean result.
    - For `clearLock`:
      - Mock Redis `del` returning 1 and 0; assert return value and that logs indicate whether lock was actually removed.

27. **Test stale task cleanup (`cleanupStaleTasks`)**
    - Arrange:
      - Insert entries into `pendingTasks` with old timestamps exceeding `TASK_TIMEOUT_MS`.
      - Mock `DatabaseService.getTaskStatus` to:
        - Return `STATUS_IN_PROGRESS` for one task.
        - Return `STATUS_COMPLETE` for another.
      - Mock `DatabaseService.updateTaskStatus` for reset to ready.
    - Act:
      - Call `processNextTask()` or directly invoke `cleanupStaleTasks()` via a test-only hook.
    - Assert:
      - Tasks still `STATUS_IN_PROGRESS` are reset to ready and removed from `pendingTasks`.
      - Completed tasks are not reset.
      - If no pending tasks remain and lock exists, `releaseLock()` is called.

---

### Phase 3 – QueueManager Enhancements

28. **Extend `tests/queue/queue-manager.test.ts` for Redis scan discovery**
    - Mock Redis `scan` to return:
      - `bull:queue1:meta`, `bull:queue2:delayed`, `bull:queue3:wait`, etc.
    - Trigger `initialize()` and ensure:
      - `queueFactory`, `workerFactory`, and `queueEventsFactory` are called for each discovered queue.
      - Errors when recreating a specific queue do not abort processing of others.

29. **Add tests for `getOrCreateQueue`**
    - New queue name:
      - Verify creation of queue, worker, and events.
      - Assert concurrency behavior (1 for `task-operator`, default for others).
    - Existing queue name:
      - Call `getOrCreateQueue` twice for same queue and assert no duplicate worker/events are created.

30. **Add tests for `hasExistingJobs`**
    - Configure mock queue to return:
      - Waiting, active, and delayed jobs with certain `name` values.
    - Cases:
      - With `excludeActive=false` and matching job names ⇒ returns `true`.
      - With `excludeActive=true` and only active jobs match ⇒ returns `false`.
      - Underlying BullMQ methods throw ⇒ logs error and returns `false`.

31. **Add tests for `addDelayedAgent`**
    - Non-task-operator:
      - Verify job is added with correct `delay`, `name`, and data.
    - Task-operator:
      - When `hasExistingJobs` returns `true` ⇒ returns `null` and logs skip.
      - When `hasExistingJobs` returns `false` ⇒ enqueues delayed job and returns job metadata.

32. **Add tests for `getAgentStatus` and `findAgentQueue`**
    - Mock queues with:
      - Repeatable jobs using IDs/keys matching `agent:<name>`.
      - Waiting/active/completed jobs with either `job.name` or `job.data.agentName` matching.
    - Assert:
      - `getAgentStatus` returns `null` when no queue matches.
      - When matching jobs exist, the returned `AgentStatus` includes:
        - `queue` name.
        - `targetUrl`, `method`, `headers`, `body`, `timeout` from recent job.
        - `schedule` from repeatable job pattern.
        - Correct `isActive`, `lastRun`, `nextRun`.

33. **Add tests for `removeAgent` and `checkAndCleanupEmptyQueue`**
    - `removeAgent`:
      - Ensure repeatable jobs and waiting/delayed jobs are removed where possible.
      - Errors on individual job removal are logged but not fatal.
      - `checkAndCleanupEmptyQueue` is invoked afterwards.
    - `checkAndCleanupEmptyQueue`:
      - For a non-default queue with zero waiting/active/delayed/repeatable jobs ⇒ `deleteQueue` is called.
      - For default queue or queues with jobs ⇒ `deleteQueue` is not called.

34. **Add tests for `deleteQueue`**
    - Queue not found ⇒ throws expected error.
    - Default queue name ⇒ throws error about not deleting default queue.
    - Queue with jobs or repeatable entries ⇒ throws error about remaining jobs.
    - Queue with no jobs:
      - Worker, events, and queue are closed.
      - Queue is removed from internal map.

---

### Phase 4 – PromptProcessor Enhancements

35. **Extend `tests/queue/prompt-processor.test.ts` for re-enqueueing**
    - Inject a mock `QueueManager` into `PromptProcessor` constructor.
    - Simulate HTTP response with JSON `{ requeue: true, delay: 5000, condition: '...', ... }`.
    - Assert:
      - `addDelayedAgent` is invoked with same agent config and `delay: 5000`.
      - Logging (if testable) notes condition.

36. **Add tests for no re-enqueue conditions**
    - Responses without `requeue` or with `requeue: false` should not call `addDelayedAgent`.

37. **Add tests for task-operator internal jobs**
    - Create a `PromptProcessor` with mock `QueueManager` and `TaskOperatorService`.
    - Case 1: task operator disabled:
      - `isTaskOperatorEnabled` returns `false`.
      - `process` receives `AgentJobData` with `targetUrl: 'task-operator://internal'`.
      - Assert: no call to `processNextTask` or `addDelayedAgent`.
    - Case 2: processed task:
      - `isTaskOperatorEnabled` returns `true`.
      - `processNextTask` returns `{ processed: true, taskId: ... }`.
      - Assert: `addDelayedAgent` called with delay ~5000ms.
    - Case 3: no tasks / lock held:
      - `processNextTask` returns `{ processed: false, reason: 'no_tasks' }` or `'lock_held'`.
      - Assert: `addDelayedAgent` called with delay ~5000ms.
    - Case 4: error in `processNextTask`:
      - `processNextTask` throws.
      - Assert: `addDelayedAgent` called with delay ~10000ms and error logged.
    - Case 5: `addDelayedAgent` returns `null`:
      - Assert logging indicates re-enqueue was skipped.

---

### Phase 5 – HTTP/API Black-box Tests (App)

38. **Extend `tests/app.test.ts` for Bull Board base path**
    - Set `process.env.BULL_BOARD_BASE_PATH` in test to a non-default path (e.g., `/agents/admin/queues`).
    - Initialize app and assert:
      - `ExpressAdapter.setBasePath` was called with that value (using mocks).
      - `GET /admin/queues` still returns 200 HTML.

39. **Add tests for `/admin/queues/refresh`**
    - Happy path:
      - Spy on internal `updateBullBoard` (or instrument via queueManager.getQueues()).
      - POST to `/admin/queues/refresh` and assert JSON `{ success: true, queueCount: ... }`.
    - Error path:
      - Force `updateBullBoard` to throw (e.g., by temporarily modifying app instance or using a mock).
      - Assert status 500 and `{ error: 'Failed to refresh Bull Board' }`.

40. **Add tests for `/queues/:queueName`**
    - Existing queue:
      - Mock `getQueueInfo` to return a sample object for name `"q1"`.
      - Assert 200 and response body equals mock.
    - Missing queue:
      - `getQueueInfo` returns `null`.
      - Assert 404 with message `Queue "q1" not found`.
    - Error path:
      - `getQueueInfo` throws; assert 500 and generic error JSON.

41. **Add tests for `/queues/:queueName` DELETE**
    - Happy path:
      - Mock `deleteQueue` to resolve.
      - Assert 200 with `success: true` and a message string.
    - Queue has jobs / cannot delete:
      - `deleteQueue` throws an error with a specific message.
      - Assert 500, error message propagated.

42. **Add tests for `/agents` endpoints**
    - `POST /agents` validation:
      - Missing `name` or `targetUrl` ⇒ 400 and error message as in `app.ts`.
      - `oneTime=false` and no `schedule` ⇒ 400 and error about needing schedule or oneTime.
    - `POST /agents` happy paths:
      - One-time agent: verify `addOneTimeAgent` called with default method and timeout, queue `'default'` when `queue` omitted.
      - Recurring agent: verify `addRecurringAgent` called with schedule, method, headers, body, timeout, queue.
    - `POST /agents` error path:
      - Underlying queue method rejects ⇒ 500, error `"Failed to create agent"`.
    - `GET /agents`:
      - `listQueues` returns `['q1', 'q2']`; `getAgentStatus` returns status objects or `null`.
      - Assert that returned `agents` list filters out `null` values.
      - Error path: `listQueues` rejects ⇒ 500 with `"Failed to list agents"`.
    - `GET /agents/:name`:
      - Agent exists ⇒ 200 with status JSON.
      - `getAgentStatus` returns `null` ⇒ 404 with `"Agent "<name>" not found"`.
      - Throws ⇒ 500 with `"Failed to get agent status"`.
    - `DELETE /agents/:name`:
      - Happy path: `removeAgent` called and 200 response.
      - Throws ⇒ 500 with `"Failed to delete agent"`.

43. **Add tests for `/task-operator` endpoints**
    - `POST /task-operator`:
      - `setSystemSetting('task_operator', true)` returns `true`; `addOneTimeAgent` returns job ⇒ 200 and success JSON with agent info.
      - `setSystemSetting` returns `false` but `addOneTimeAgent` returns job ⇒ still 200, with warning log.
      - `addOneTimeAgent` throws ⇒ 500 and `"Failed to enqueue task operator"`.
    - `DELETE /task-operator`:
      - `setSystemSetting('task_operator', false)` returns `true`; `removeAgent('task-operator')` resolves or throws “not found” (ignored) ⇒ 200 with success JSON.
      - `setSystemSetting` returns `false` ⇒ 500 with `"Failed to disable task operator"`; no call to `removeAgent`.
      - Unexpected error ⇒ 500 same message.

44. **Add tests for `/task-operator/lock` endpoints**
    - `GET /task-operator/lock`:
      - `isProcessing` returns `true` and `false` in different tests; assert `isLocked` and message string.
      - Error path: `isProcessing` throws; assert 500 and `"Failed to check task operator lock status"`.
    - `DELETE /task-operator/lock`:
      - `clearLock` returns `true` ⇒ 200 with `lockCleared: true`.
      - `clearLock` returns `false` ⇒ 200 with `lockCleared: false`.
      - `clearLock` throws ⇒ 500 and `"Failed to clear task operator lock"`.

45. **Add tests for `/task-operator/callback` endpoint**
    - Secret handling:
      - Set `process.env.WEBHOOK_SECRET`.
      - Missing or incorrect secret in headers or query string ⇒ 401 with `"Unauthorized"`.
      - Correct secret ⇒ proceeds to requestId checks.
    - Validation:
      - Missing `requestId` and `request_id` ⇒ 400 with `"requestId is required"` and a log warning.
    - Happy path:
      - Mock `TaskOperatorService.getInstance().handleCallback` to resolve.
      - Post body with `requestId` and `success: true`.
      - Assert 200 with `{ received: true, requestId }`.
    - Internal error:
      - Make `handleCallback` throw.
      - Assert 200 with `{ received: true, error: 'Internal error processing callback' }` and error log.

---

### Phase 6 – MCP Server Black-box Tests

46. **Extend `tests/mcp/server.test.ts` for JSON payload assertions**
    - For each tool handler (`create_agent`, `list_agents`, `get_agent_status`, `delete_agent`, `list_queues`, `get_queue_info`, `delete_queue`):
      - Parse `content[0].text` as JSON.
      - Assert exact structure (keys, types, and important messages), not just presence of `content`.

47. **Add tests for queue-related MCP tools**
    - `list_queues`:
      - Mock `QueueManager.listQueues` and `getQueueInfo` to return queue objects.
      - Assert JSON includes `queues` array with expected entries.
    - `get_queue_info`:
      - Existing queue ⇒ returns JSON of queue info.
      - Missing queue ⇒ result has `isError: true` and error message.
    - `delete_queue`:
      - Happy path ⇒ success JSON with correct message.
      - Queue not found or has jobs ⇒ `QueueManager.deleteQueue` throws; assert `isError: true` with message.

48. **Add tests for MCP resources (agents)**
    - Resource listing:
      - Mock `listQueues` to return a list.
      - Invoke resource list handler (via test-only access or with a thin wrapper) and assert:
        - URIs are of form `agent://{name}`.
        - `resourceCount` equals number of queues.
    - Resource read:
      - For existing agent:
        - `getAgentStatus` returns a status object.
        - Handler returns `contents[0].text` JSON representing that status.
      - Non-existent agent:
        - `getAgentStatus` returns `null`.
        - Handler throws `"Agent "<name>" not found"`; assert rejection in test.

49. **Add logging expectation tests**
    - Mock or spy on `logger.info` / `logger.error`.
    - For representative tools (e.g., `create_agent`, `list_agents`), assert:
      - A “MCP tool called” log occurs with the correct tool name.
      - A “MCP tool completed” log occurs with `success` flag based on handler result.

---

### Phase 7 – Integration & E2E-lite Scenarios

50. **Enhance `tests/integration.test.ts` for richer agent lifecycle**
    - Use the real `CursorAgentsApp` with a mocked `QueueManager` that behaves more like production (e.g., retains state).
    - Scenario:
      - Create agent via `POST /agents`.
      - Confirm `/agents/:name` returns status.
      - Delete via `DELETE /agents/:name`.
      - Confirm `/agents/:name` now returns 404.

51. **Add task-operator lifecycle integration test**
    - Use fakes/mocks for SQLite and Redis but keep `TaskOperatorService` real where possible.
    - Steps:
      - Insert one ready task into the fake DB.
      - Enable `task_operator` setting.
      - Trigger a task-operator job via `/task-operator` (enqueue).
      - Simulate cursor-runner callback to `/task-operator/callback` for that request.
      - Assert:
        - Task is marked complete.
        - Lock gets released.

52. **Add failure-injection integration tests**
    - Simulate Redis being down (BullMQ operations rejecting) during queue operations.
    - Assert:
      - HTTP endpoints return 500 JSON errors but the process (app instance) continues to respond to other requests.
    - Simulate MCP handlers failing due to queue issues and ensure MCP responses contain `isError: true` fields without crashing.

53. **Add E2E-lite entrypoint tests (optional but recommended)**
    - Using `child_process.spawn` on the compiled JS entrypoints:
      - Start `src/index.js` (built output), wait until it logs startup, then send `SIGTERM` / `SIGINT` and ensure exit code `0`.
      - Start `src/mcp/index.js` with a mocked Redis URL and ensure it logs startup or logs and exits on Redis failure.
    - Place these in a dedicated suite (e.g., `tests/e2e/entrypoints.test.ts`) gated by `test:e2e-lite`.

---

### Phase 8 – Coverage & CI Tightening

54. **Measure coverage and identify remaining gaps**
    - Run `npm run test:coverage`.
    - Note any files in `src/` (excluding entrypoints) with significantly low coverage.

55. **Add targeted tests for uncovered branches**
    - For each under-covered area (especially complex `if`/`catch` branches), add unit or integration tests following the patterns above.

56. **Raise Jest coverage thresholds**
    - In `jest.config.js`, configure `coverageThreshold` for `src/**` (excluding entrypoints) based on current stable coverage (e.g., lines 80–85%).
    - Ensure CI passes with the new thresholds.

57. **Finalize CI test matrix**
    - Update CI configuration (GitHub Actions, etc.) to run:
      - `npm run test:unit`
      - `npm run test:http`
      - `npm run test:e2e-lite` (optional or nightly)
    - Confirm the pipeline remains green and stable.


