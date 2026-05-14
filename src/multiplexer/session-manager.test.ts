import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test';
import { MultiplexerSessionManager } from './session-manager';

// Define the mock multiplexer
const mockMultiplexer = {
  type: 'tmux' as const,
  isAvailable: mock(async () => true),
  isInsideSession: mock(() => true),
  spawnPane: mock(async () => ({
    success: true,
    paneId: '%mock-pane',
  })),
  closePane: mock(async () => true),
  applyLayout: mock(async () => {}),
};

// Mock the multiplexer module
mock.module('../multiplexer', () => ({
  getMultiplexer: () => mockMultiplexer,
  isServerRunning: mock(async () => true),
  startAvailabilityCheck: () => {},
}));

// Mock the plugin context
function createMockContext(overrides?: {
  sessionStatusResult?: { data?: Record<string, { type: string }> };
  directory?: string;
}) {
  const defaultPort = process.env.OPENCODE_PORT ?? '4096';
  return {
    client: {
      session: {
        status: mock(
          async () => overrides?.sessionStatusResult ?? { data: {} },
        ),
      },
    },
    directory: overrides?.directory ?? '/test/directory',
    serverUrl: new URL(`http://localhost:${defaultPort}`),
  } as any;
}

const defaultMultiplexerConfig = {
  type: 'tmux' as const,
  layout: 'main-vertical' as const,
  main_pane_size: 60,
};

function createDeferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

describe('MultiplexerSessionManager', () => {
  const realDateNow = Date.now;
  const originalChildEnv = process.env.OMOS_MULTIPLEXER_CHILD;
  const originalTmuxPane = process.env.TMUX_PANE;

  beforeEach(() => {
    mockMultiplexer.spawnPane.mockReset();
    mockMultiplexer.spawnPane.mockResolvedValue({
      success: true,
      paneId: '%mock-pane',
    });
    mockMultiplexer.closePane.mockReset();
    mockMultiplexer.closePane.mockResolvedValue(true);
    mockMultiplexer.isInsideSession.mockReset();
    mockMultiplexer.isInsideSession.mockReturnValue(true);
    Date.now = realDateNow;
    delete process.env.OMOS_MULTIPLEXER_CHILD;
    process.env.TMUX_PANE = '%controller';
    (MultiplexerSessionManager as any).activeControllerKey = null;
    (MultiplexerSessionManager as any).hasActiveController = false;
  });

  afterEach(() => {
    Date.now = realDateNow;
    if (originalChildEnv === undefined) {
      delete process.env.OMOS_MULTIPLEXER_CHILD;
    } else {
      process.env.OMOS_MULTIPLEXER_CHILD = originalChildEnv;
    }
    if (originalTmuxPane === undefined) {
      delete process.env.TMUX_PANE;
    } else {
      process.env.TMUX_PANE = originalTmuxPane;
    }
    (MultiplexerSessionManager as any).activeControllerKey = null;
    (MultiplexerSessionManager as any).hasActiveController = false;
  });

  describe('constructor', () => {
    test('initializes with config', () => {
      const ctx = createMockContext();
      const manager = new MultiplexerSessionManager(
        ctx,
        defaultMultiplexerConfig,
      );
      expect(manager).toBeDefined();
    });

    test('disables pane spawning inside spawned child attach panes', async () => {
      process.env.OMOS_MULTIPLEXER_CHILD = '1';
      const ctx = createMockContext();
      const manager = new MultiplexerSessionManager(
        ctx,
        defaultMultiplexerConfig,
      );

      await manager.onSessionCreated({
        type: 'session.created',
        properties: { info: { id: 'child-env', parentID: 'parent-env' } },
      });

      expect(mockMultiplexer.spawnPane).not.toHaveBeenCalled();
    });

    test('only one plugin instance owns multiplexer pane spawning per pane', async () => {
      const ctx = createMockContext();
      const first = new MultiplexerSessionManager(
        ctx,
        defaultMultiplexerConfig,
      );
      const second = new MultiplexerSessionManager(
        ctx,
        defaultMultiplexerConfig,
      );

      await first.onSessionCreated({
        type: 'session.created',
        properties: { info: { id: 'child-first', parentID: 'parent' } },
      });
      await second.onSessionCreated({
        type: 'session.created',
        properties: { info: { id: 'child-second', parentID: 'parent' } },
      });

      expect(mockMultiplexer.spawnPane).toHaveBeenCalledTimes(1);
      expect(mockMultiplexer.spawnPane).toHaveBeenCalledWith(
        'child-first',
        'Subagent',
        `http://localhost:${process.env.OPENCODE_PORT ?? '4096'}/`,
        '/test/directory',
      );
    });
  });

  describe('onSessionCreated', () => {
    test('spawns pane for child sessions', async () => {
      const ctx = createMockContext();
      const manager = new MultiplexerSessionManager(
        ctx,
        defaultMultiplexerConfig,
      );

      await manager.onSessionCreated({
        type: 'session.created',
        properties: {
          info: {
            id: 'child-123',
            parentID: 'parent-456',
            title: 'Test Worker',
          },
        },
      });

      expect(mockMultiplexer.spawnPane).toHaveBeenCalled();
      expect(mockMultiplexer.spawnPane).toHaveBeenCalledWith(
        'child-123',
        'Test Worker',
        `http://localhost:${process.env.OPENCODE_PORT ?? '4096'}/`,
        '/test/directory',
      );
    });

    test('ignores sessions without parentID', async () => {
      const ctx = createMockContext();
      const manager = new MultiplexerSessionManager(
        ctx,
        defaultMultiplexerConfig,
      );

      await manager.onSessionCreated({
        type: 'session.created',
        properties: {
          info: {
            id: 'root-session',
            title: 'Main Chat',
          },
        },
      });

      expect(mockMultiplexer.spawnPane).not.toHaveBeenCalled();
    });

    test('prefers child session directory when present', async () => {
      const ctx = createMockContext({ directory: '/parent/directory' });
      const manager = new MultiplexerSessionManager(
        ctx,
        defaultMultiplexerConfig,
      );

      await manager.onSessionCreated({
        type: 'session.created',
        properties: {
          info: {
            id: 'child-456',
            parentID: 'parent-456',
            title: 'Nested Worker',
            directory: '/child/directory',
          },
        },
      });

      expect(mockMultiplexer.spawnPane).toHaveBeenCalledWith(
        'child-456',
        'Nested Worker',
        `http://localhost:${process.env.OPENCODE_PORT ?? '4096'}/`,
        '/child/directory',
      );
    });

    test('ignores if disabled in config', async () => {
      const ctx = createMockContext();
      const manager = new MultiplexerSessionManager(ctx, {
        ...defaultMultiplexerConfig,
        type: 'none',
      });

      await manager.onSessionCreated({
        type: 'session.created',
        properties: {
          info: { id: 'child', parentID: 'parent' },
        },
      });

      expect(mockMultiplexer.spawnPane).not.toHaveBeenCalled();
    });

    test('does not spawn twice for duplicate create events while spawning', async () => {
      const ctx = createMockContext();
      const manager = new MultiplexerSessionManager(
        ctx,
        defaultMultiplexerConfig,
      );
      const deferred = createDeferred<{ success: true; paneId: string }>();

      mockMultiplexer.spawnPane.mockImplementationOnce(() => deferred.promise);

      const event = {
        type: 'session.created',
        properties: {
          info: {
            id: 'child-race',
            parentID: 'parent-race',
            title: 'Race Worker',
          },
        },
      };

      const firstCreate = manager.onSessionCreated(event);
      const secondCreate = manager.onSessionCreated(event);

      await Promise.resolve();

      expect(mockMultiplexer.spawnPane).toHaveBeenCalledTimes(1);

      deferred.resolve({ success: true, paneId: 'p-race' });

      await Promise.all([firstCreate, secondCreate]);

      expect(mockMultiplexer.spawnPane).toHaveBeenCalledTimes(1);
    });

    test('does not respawn known sessions on replayed create events', async () => {
      const ctx = createMockContext();
      const manager = new MultiplexerSessionManager(
        ctx,
        defaultMultiplexerConfig,
      );

      await manager.onSessionCreated({
        type: 'session.created',
        properties: {
          info: { id: 'child-known', parentID: 'parent-known' },
        },
      });
      await (manager as any).closeSession('child-known', 'idle');
      await manager.onSessionCreated({
        type: 'session.created',
        properties: {
          info: { id: 'child-known', parentID: 'parent-known' },
        },
      });

      expect(mockMultiplexer.spawnPane).toHaveBeenCalledTimes(1);
    });
  });

  describe('polling and closure', () => {
    test('does not close pane on early idle status event', async () => {
      const ctx = createMockContext();
      const manager = new MultiplexerSessionManager(
        ctx,
        defaultMultiplexerConfig,
      );

      await manager.onSessionCreated({
        type: 'session.created',
        properties: { info: { id: 'c-early-idle', parentID: 'p1' } },
      });

      await manager.onSessionStatus({
        type: 'session.status',
        properties: {
          sessionID: 'c-early-idle',
          status: { type: 'idle' },
        },
      });

      expect(mockMultiplexer.closePane).not.toHaveBeenCalled();
    });

    test('closes pane when idle persists after busy, grace, and debounce', async () => {
      const ctx = createMockContext();
      mockMultiplexer.spawnPane.mockResolvedValue({
        success: true,
        paneId: 'p-1',
      });
      let now = 1_000;
      Date.now = () => now;

      const manager = new MultiplexerSessionManager(
        ctx,
        defaultMultiplexerConfig,
      );

      // Register session
      await manager.onSessionCreated({
        type: 'session.created',
        properties: { info: { id: 'c1', parentID: 'p1' } },
      });
      await manager.onSessionStatus({
        type: 'session.status',
        properties: { sessionID: 'c1', status: { type: 'busy' } },
      });

      ctx.client.session.status.mockResolvedValue({
        data: { c1: { type: 'idle' } },
      });

      await (manager as any).pollSessions();
      expect(mockMultiplexer.closePane).not.toHaveBeenCalled();

      now += 16_000;
      await (manager as any).pollSessions();

      expect(mockMultiplexer.closePane).toHaveBeenCalledWith('p-1');
    });

    test('busy status clears a pending idle debounce', async () => {
      const ctx = createMockContext();
      let now = 1_000;
      Date.now = () => now;
      const manager = new MultiplexerSessionManager(
        ctx,
        defaultMultiplexerConfig,
      );

      await manager.onSessionCreated({
        type: 'session.created',
        properties: { info: { id: 'c-idle-busy', parentID: 'p1' } },
      });

      await manager.onSessionStatus({
        type: 'session.status',
        properties: {
          sessionID: 'c-idle-busy',
          status: { type: 'idle' },
        },
      });

      now += 16_000;
      await manager.onSessionStatus({
        type: 'session.status',
        properties: {
          sessionID: 'c-idle-busy',
          status: { type: 'busy' },
        },
      });
      await manager.onSessionStatus({
        type: 'session.status',
        properties: {
          sessionID: 'c-idle-busy',
          status: { type: 'idle' },
        },
      });

      expect(mockMultiplexer.closePane).not.toHaveBeenCalled();
    });

    test('busy during spawn is remembered so later idle can close', async () => {
      const ctx = createMockContext();
      let now = 1_000;
      Date.now = () => now;
      const manager = new MultiplexerSessionManager(
        ctx,
        defaultMultiplexerConfig,
      );
      const deferred = createDeferred<{ success: true; paneId: string }>();
      mockMultiplexer.spawnPane.mockImplementationOnce(() => deferred.promise);

      const createPromise = manager.onSessionCreated({
        type: 'session.created',
        properties: {
          info: { id: 'child-spawn-busy', parentID: 'parent-spawn-busy' },
        },
      });
      await Promise.resolve();

      await manager.onSessionStatus({
        type: 'session.status',
        properties: {
          sessionID: 'child-spawn-busy',
          status: { type: 'busy' },
        },
      });

      deferred.resolve({ success: true, paneId: 'p-spawn-busy' });
      await createPromise;

      ctx.client.session.status.mockResolvedValue({
        data: { 'child-spawn-busy': { type: 'idle' } },
      });
      now += 16_000;
      await (manager as any).pollSessions();
      now += 7_500;
      await (manager as any).pollSessions();

      expect(mockMultiplexer.closePane).toHaveBeenCalledWith('p-spawn-busy');
    });

    test('persistent pre-busy idle eventually closes after grace', async () => {
      const ctx = createMockContext();
      let now = 1_000;
      Date.now = () => now;
      const manager = new MultiplexerSessionManager(
        ctx,
        defaultMultiplexerConfig,
      );

      await manager.onSessionCreated({
        type: 'session.created',
        properties: { info: { id: 'child-pre-busy', parentID: 'parent' } },
      });
      await manager.onSessionStatus({
        type: 'session.status',
        properties: {
          sessionID: 'child-pre-busy',
          status: { type: 'idle' },
        },
      });

      now += 16_000;
      await manager.onSessionStatus({
        type: 'session.status',
        properties: {
          sessionID: 'child-pre-busy',
          status: { type: 'idle' },
        },
      });

      expect(mockMultiplexer.closePane).toHaveBeenCalled();
    });

    test('handles session.idle events like idle status events', async () => {
      const ctx = createMockContext();
      let now = 1_000;
      Date.now = () => now;
      const manager = new MultiplexerSessionManager(
        ctx,
        defaultMultiplexerConfig,
      );

      await manager.onSessionCreated({
        type: 'session.created',
        properties: { info: { id: 'child-idle-event', parentID: 'parent' } },
      });
      await manager.onSessionStatus({
        type: 'session.idle',
        properties: { sessionID: 'child-idle-event' },
      });

      now += 16_000;
      await manager.onSessionStatus({
        type: 'session.idle',
        properties: { sessionID: 'child-idle-event' },
      });

      expect(mockMultiplexer.closePane).toHaveBeenCalled();
    });

    test('does not close on missing status during initial grace period', async () => {
      const ctx = createMockContext();
      let now = 1_000;
      Date.now = () => now;
      const manager = new MultiplexerSessionManager(
        ctx,
        defaultMultiplexerConfig,
      );

      await manager.onSessionCreated({
        type: 'session.created',
        properties: { info: { id: 'c-missing-grace', parentID: 'p1' } },
      });
      await manager.onSessionStatus({
        type: 'session.status',
        properties: {
          sessionID: 'c-missing-grace',
          status: { type: 'busy' },
        },
      });

      ctx.client.session.status.mockResolvedValue({ data: {} });
      await (manager as any).pollSessions();
      now += 16_000;
      await (manager as any).pollSessions();

      expect(mockMultiplexer.closePane).not.toHaveBeenCalled();
    });

    test('closes on missing status only after busy, grace, and missing debounce', async () => {
      const ctx = createMockContext();
      let now = 1_000;
      Date.now = () => now;
      const manager = new MultiplexerSessionManager(
        ctx,
        defaultMultiplexerConfig,
      );

      await manager.onSessionCreated({
        type: 'session.created',
        properties: { info: { id: 'c-missing-close', parentID: 'p1' } },
      });
      await manager.onSessionStatus({
        type: 'session.status',
        properties: {
          sessionID: 'c-missing-close',
          status: { type: 'busy' },
        },
      });

      ctx.client.session.status.mockResolvedValue({ data: {} });
      now += 16_000;
      await (manager as any).pollSessions();
      expect(mockMultiplexer.closePane).not.toHaveBeenCalled();

      now += 7_500;
      await (manager as any).pollSessions();

      expect(mockMultiplexer.closePane).toHaveBeenCalled();
    });

    test('does not close on transient status absence', async () => {
      const ctx = createMockContext();
      const manager = new MultiplexerSessionManager(
        ctx,
        defaultMultiplexerConfig,
      );

      await manager.onSessionCreated({
        type: 'session.created',
        properties: { info: { id: 'c1', parentID: 'p1' } },
      });

      ctx.client.session.status.mockResolvedValue({ data: {} });
      await (manager as any).pollSessions();

      expect(mockMultiplexer.closePane).not.toHaveBeenCalled();
    });

    test('respawns pane on later busy after idle close for resumable session', async () => {
      const ctx = createMockContext();
      const manager = new MultiplexerSessionManager(
        ctx,
        defaultMultiplexerConfig,
      );

      mockMultiplexer.spawnPane
        .mockResolvedValueOnce({
          success: true,
          paneId: 'p-1',
        })
        .mockResolvedValueOnce({
          success: true,
          paneId: 'p-2',
        });

      await manager.onSessionCreated({
        type: 'session.created',
        properties: {
          info: {
            id: 'child-789',
            parentID: 'parent-789',
            title: 'Worker',
            directory: '/task/dir',
          },
        },
      });

      await manager.onSessionStatus({
        type: 'session.status',
        properties: {
          sessionID: 'child-789',
          status: { type: 'busy' },
        },
      });

      (manager as any).sessions.get('child-789').createdAt -= 16_000;
      ctx.client.session.status.mockResolvedValue({
        data: { 'child-789': { type: 'idle' } },
      });
      await (manager as any).pollSessions();
      (manager as any).sessions.get('child-789').idleSince -= 16_000;
      await (manager as any).pollSessions();

      await manager.onSessionStatus({
        type: 'session.status',
        properties: {
          sessionID: 'child-789',
          status: { type: 'busy' },
        },
      });

      expect(mockMultiplexer.spawnPane).toHaveBeenCalledTimes(2);
      expect(mockMultiplexer.spawnPane).toHaveBeenCalledWith(
        'child-789',
        'Worker',
        `http://localhost:${process.env.OPENCODE_PORT ?? '4096'}/`,
        '/task/dir',
      );
      expect(mockMultiplexer.closePane).toHaveBeenCalledWith('p-1');
      expect(mockMultiplexer.closePane).toHaveBeenCalledTimes(1);
    });

    test('respawns after in-flight idle close when busy resumes same session', async () => {
      const ctx = createMockContext();
      let now = 1_000;
      Date.now = () => now;
      const manager = new MultiplexerSessionManager(
        ctx,
        defaultMultiplexerConfig,
      );
      const closeDeferred = createDeferred<boolean>();

      mockMultiplexer.spawnPane
        .mockResolvedValueOnce({
          success: true,
          paneId: 'p-close-race',
        })
        .mockResolvedValueOnce({
          success: true,
          paneId: 'p-close-race-resumed',
        });
      mockMultiplexer.closePane.mockImplementationOnce(
        () => closeDeferred.promise,
      );

      await manager.onSessionCreated({
        type: 'session.created',
        properties: {
          info: {
            id: 'child-close-race',
            parentID: 'parent-close-race',
            title: 'Worker',
          },
        },
      });

      await manager.onSessionStatus({
        type: 'session.status',
        properties: {
          sessionID: 'child-close-race',
          status: { type: 'busy' },
        },
      });

      await manager.onSessionStatus({
        type: 'session.status',
        properties: {
          sessionID: 'child-close-race',
          status: { type: 'idle' },
        },
      });

      now += 16_000;

      const idlePromise = manager.onSessionStatus({
        type: 'session.status',
        properties: {
          sessionID: 'child-close-race',
          status: { type: 'idle' },
        },
      });

      await Promise.resolve();

      const busyPromise = manager.onSessionStatus({
        type: 'session.status',
        properties: {
          sessionID: 'child-close-race',
          status: { type: 'busy' },
        },
      });

      expect(mockMultiplexer.spawnPane).toHaveBeenCalledTimes(1);

      closeDeferred.resolve(true);
      await Promise.all([idlePromise, busyPromise]);

      expect(mockMultiplexer.closePane).toHaveBeenCalledTimes(1);
      expect(mockMultiplexer.spawnPane).toHaveBeenCalledTimes(2);
      expect(mockMultiplexer.spawnPane).toHaveBeenLastCalledWith(
        'child-close-race',
        'Worker',
        `http://localhost:${process.env.OPENCODE_PORT ?? '4096'}/`,
        '/test/directory',
      );
    });

    test('does not respawn after in-flight close if session is deleted', async () => {
      const ctx = createMockContext();
      let now = 1_000;
      Date.now = () => now;
      const manager = new MultiplexerSessionManager(
        ctx,
        defaultMultiplexerConfig,
      );
      const closeDeferred = createDeferred<boolean>();

      mockMultiplexer.spawnPane
        .mockResolvedValueOnce({
          success: true,
          paneId: 'p-delete-race',
        })
        .mockResolvedValueOnce({
          success: true,
          paneId: 'p-should-not-respawn',
        });
      mockMultiplexer.closePane.mockImplementationOnce(
        () => closeDeferred.promise,
      );

      await manager.onSessionCreated({
        type: 'session.created',
        properties: {
          info: {
            id: 'child-delete-race',
            parentID: 'parent-delete-race',
            title: 'Worker',
          },
        },
      });

      await manager.onSessionStatus({
        type: 'session.status',
        properties: {
          sessionID: 'child-delete-race',
          status: { type: 'idle' },
        },
      });

      now += 16_000;

      const idlePromise = manager.onSessionStatus({
        type: 'session.status',
        properties: {
          sessionID: 'child-delete-race',
          status: { type: 'idle' },
        },
      });

      await Promise.resolve();

      const busyPromise = manager.onSessionStatus({
        type: 'session.status',
        properties: {
          sessionID: 'child-delete-race',
          status: { type: 'busy' },
        },
      });

      const deletedPromise = manager.onSessionDeleted({
        type: 'session.deleted',
        properties: {
          sessionID: 'child-delete-race',
        },
      });

      closeDeferred.resolve(true);
      await Promise.all([idlePromise, busyPromise, deletedPromise]);

      expect(mockMultiplexer.closePane).toHaveBeenCalledTimes(1);
      expect(mockMultiplexer.spawnPane).toHaveBeenCalledTimes(1);
    });

    test('closes pane on session.deleted using info.id', async () => {
      const ctx = createMockContext();
      const manager = new MultiplexerSessionManager(
        ctx,
        defaultMultiplexerConfig,
      );

      mockMultiplexer.spawnPane.mockResolvedValueOnce({
        success: true,
        paneId: 'p-info-id',
      });

      await manager.onSessionCreated({
        type: 'session.created',
        properties: {
          info: {
            id: 'child-info-id',
            parentID: 'parent-info-id',
          },
        },
      });

      await manager.onSessionDeleted({
        type: 'session.deleted',
        properties: {
          info: { id: 'child-info-id' },
        },
      });

      expect(mockMultiplexer.closePane).toHaveBeenCalledWith('p-info-id');

      await manager.onSessionStatus({
        type: 'session.status',
        properties: {
          sessionID: 'child-info-id',
          status: { type: 'busy' },
        },
      });

      expect(mockMultiplexer.spawnPane).toHaveBeenCalledTimes(1);
    });

    test('closes pane returned by a stale spawn after session deleted', async () => {
      const ctx = createMockContext();
      const manager = new MultiplexerSessionManager(
        ctx,
        defaultMultiplexerConfig,
      );
      const spawnDeferred = createDeferred<{ success: true; paneId: string }>();

      mockMultiplexer.spawnPane.mockImplementationOnce(
        () => spawnDeferred.promise,
      );

      const createPromise = manager.onSessionCreated({
        type: 'session.created',
        properties: {
          info: {
            id: 'child-stale-spawn',
            parentID: 'parent-stale-spawn',
          },
        },
      });

      await Promise.resolve();

      await manager.onSessionDeleted({
        type: 'session.deleted',
        properties: {
          info: { id: 'child-stale-spawn' },
        },
      });

      spawnDeferred.resolve({ success: true, paneId: 'p-stale-spawn' });
      await createPromise;

      expect(mockMultiplexer.closePane).toHaveBeenCalledWith('p-stale-spawn');
    });

    test('does nothing on busy for unknown session', async () => {
      const ctx = createMockContext();
      const manager = new MultiplexerSessionManager(
        ctx,
        defaultMultiplexerConfig,
      );

      await manager.onSessionStatus({
        type: 'session.status',
        properties: {
          sessionID: 'unknown-session',
          status: { type: 'busy' },
        },
      });

      expect(mockMultiplexer.spawnPane).not.toHaveBeenCalled();
    });

    test('does not respawn while initial pane spawn is still in progress', async () => {
      const ctx = createMockContext();
      const manager = new MultiplexerSessionManager(
        ctx,
        defaultMultiplexerConfig,
      );
      const deferred = createDeferred<{ success: true; paneId: string }>();

      mockMultiplexer.spawnPane.mockImplementationOnce(() => deferred.promise);

      const createPromise = manager.onSessionCreated({
        type: 'session.created',
        properties: {
          info: {
            id: 'child-busy-race',
            parentID: 'parent-busy-race',
            title: 'Busy Worker',
            directory: '/task/dir',
          },
        },
      });

      await manager.onSessionStatus({
        type: 'session.status',
        properties: {
          sessionID: 'child-busy-race',
          status: { type: 'busy' },
        },
      });

      expect(mockMultiplexer.spawnPane).toHaveBeenCalledTimes(1);

      deferred.resolve({ success: true, paneId: 'p-busy-race' });

      await createPromise;

      expect(mockMultiplexer.spawnPane).toHaveBeenCalledTimes(1);
    });
  });

  describe('cleanup', () => {
    test('closes all tracked panes concurrently', async () => {
      const ctx = createMockContext();
      mockMultiplexer.spawnPane
        .mockResolvedValueOnce({ success: true, paneId: 'p1' })
        .mockResolvedValueOnce({ success: true, paneId: 'p2' });

      const manager = new MultiplexerSessionManager(
        ctx,
        defaultMultiplexerConfig,
      );

      await manager.onSessionCreated({
        type: 'session.created',
        properties: { info: { id: 's1', parentID: 'p1' } },
      });
      await manager.onSessionCreated({
        type: 'session.created',
        properties: { info: { id: 's2', parentID: 'p2' } },
      });

      await manager.cleanup();

      expect(mockMultiplexer.closePane).toHaveBeenCalledTimes(2);
      expect(mockMultiplexer.closePane).toHaveBeenCalledWith('p1');
      expect(mockMultiplexer.closePane).toHaveBeenCalledWith('p2');
    });

    test('clears spawning sessions during cleanup', async () => {
      const ctx = createMockContext();
      const manager = new MultiplexerSessionManager(
        ctx,
        defaultMultiplexerConfig,
      );

      const deferred = createDeferred<{ success: true; paneId: string }>();
      mockMultiplexer.spawnPane.mockImplementationOnce(() => deferred.promise);
      const event = {
        type: 'session.created',
        properties: {
          info: {
            id: 'cleanup-spawn',
            parentID: 'parent-cleanup',
            title: 'Cleanup Worker',
          },
        },
      };

      const createPromise = manager.onSessionCreated(event);

      await Promise.resolve();

      await manager.cleanup();

      await manager.onSessionCreated(event);

      deferred.resolve({ success: true, paneId: 'p-cleanup' });
      await createPromise;

      expect(mockMultiplexer.spawnPane).toHaveBeenCalledTimes(2);
    });
  });
});

// Backward compatibility test
describe('TmuxSessionManager (backward compatibility)', () => {
  test('TmuxSessionManager is alias for MultiplexerSessionManager', async () => {
    const { TmuxSessionManager } = await import('./session-manager');
    expect(TmuxSessionManager).toBe(MultiplexerSessionManager);
  });
});
