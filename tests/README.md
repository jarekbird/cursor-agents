# Test Suite for cursor-agents

This directory contains the comprehensive test suite for the cursor-agents application.

## Test Structure

```
tests/
├── setup.ts                    # Test setup and global configuration
├── queue/
│   ├── prompt-processor.test.ts    # Tests for HTTP agent job processing
│   └── queue-manager.test.ts        # Tests for BullMQ queue management
├── app.test.ts                 # Tests for Express API endpoints
├── mcp/
│   └── server.test.ts          # Tests for MCP server tools
└── integration.test.ts         # Integration tests for full workflows
```

## Running Tests

```bash
# Run all tests
npm test

# Run tests in watch mode
npm run test:watch

# Run tests with coverage
npm run test:coverage

# Run specific test file
npm test -- tests/queue/prompt-processor.test.ts
```

## Test Coverage

### PromptProcessor Tests ✅
- HTTP GET requests
- HTTP POST requests with body
- Error handling (HTTP errors, network errors)
- Timeout handling
- JSON and non-JSON response parsing
- Cursor-runner API integration
- Default branch handling

### QueueManager Tests ✅
- Redis connection initialization
- Adding recurring prompts
- Adding one-time agents
- Adding recurring agents
- Getting prompt/agent status
- Removing prompts/agents
- Listing queues
- Graceful shutdown

### App Tests (In Progress)
- Health check endpoint
- Queue listing endpoint
- Creating recurring prompts
- Getting prompt status
- Deleting prompts
- Bull Board dashboard mounting
- Error handling

### MCP Server Tests (In Progress)
- Creating agents (one-time and recurring)
- Listing agents
- Getting agent status
- Deleting agents
- Error handling

### Integration Tests (In Progress)
- Full agent lifecycle (create, status, delete)
- HTTP agent execution
- Error handling across components
- Queue management workflows

## Test Patterns

### Mocking Strategy

1. **External Dependencies**: Mock Redis, BullMQ, and HTTP requests
2. **Module Mocks**: Use `jest.mock()` for module-level mocking
3. **Function Mocks**: Use `jest.fn()` for function-level mocking
4. **Type Safety**: Use TypeScript types with `jest.Mocked<>` for type-safe mocks

### Example Test Structure

```typescript
import { describe, it, expect, beforeEach, afterEach, jest } from '@jest/globals';

describe('ComponentName', () => {
  let component: Component;
  let mockDependency: jest.Mocked<Dependency>;

  beforeEach(() => {
    // Setup mocks
    mockDependency = {
      method: jest.fn().mockResolvedValue(result),
    } as unknown as jest.Mocked<Dependency>;

    // Create component instance
    component = new Component(mockDependency);
  });

  afterEach(async () => {
    // Cleanup
    await component.shutdown().catch(() => {});
  });

  it('should do something', async () => {
    // Arrange
    const input = { /* ... */ };

    // Act
    const result = await component.method(input);

    // Assert
    expect(result).toEqual(expected);
    expect(mockDependency.method).toHaveBeenCalledWith(input);
  });
});
```

## Current Status

- ✅ **PromptProcessor**: 11/11 tests passing
- ✅ **QueueManager**: 16/16 tests passing
- ✅ **App**: 15/15 tests passing
- ✅ **MCP Server**: 9/9 tests passing
- ✅ **Integration**: 5/5 tests passing

**Total: 56/56 tests passing** ✅

## Test Architecture

The tests are **application-level tests** that test the Express application directly using `supertest`. They do not test Traefik routing configuration. The application receives requests at standard paths (e.g., `/health`, `/queues`, `/admin/queues`), and Traefik handles the path prefix (`/agents`) at the reverse proxy level.

## Next Steps

1. Add more edge case tests
2. Improve test coverage for error scenarios
3. Add performance tests for high-volume job processing
4. Add end-to-end tests that include Traefik routing (optional)

## Coverage Goals

- **Unit Tests**: 80%+ coverage for core logic
- **Integration Tests**: Cover main workflows
- **Error Handling**: Test all error paths
- **Edge Cases**: Test boundary conditions

