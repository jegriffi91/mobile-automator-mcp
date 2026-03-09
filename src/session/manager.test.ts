import { describe, it, expect, beforeEach, vi, type Mocked } from 'vitest';
import { SessionManager } from './manager.js';
import { SessionDatabase } from './database.js';
import type { Session, SessionStatus } from '../types.js';

vi.mock('./database.js');

describe('SessionManager', () => {
    let manager: SessionManager;
    let mockDb: Mocked<SessionDatabase>;

    beforeEach(() => {
        mockDb = {
            getSession: vi.fn(),
            updateSessionStatus: vi.fn(),
            updateSessionStopped: vi.fn(),
        } as unknown as Mocked<SessionDatabase>;

        manager = new SessionManager(mockDb);
    });

    describe('transition()', () => {
        const createMockSession = (status: SessionStatus): Session => ({
            id: 'test-session-123',
            appBundleId: 'com.example.app',
            platform: 'ios',
            status,
            startedAt: '2023-01-01T00:00:00Z',
        });

        it('should transition from recording to compiling', async () => {
            mockDb.getSession.mockReturnValue(createMockSession('recording'));

            await manager.transition('test-session-123', 'compiling');

            expect(mockDb.getSession).toHaveBeenCalledWith('test-session-123');
            expect(mockDb.updateSessionStatus).toHaveBeenCalledWith('test-session-123', 'compiling');
            expect(mockDb.updateSessionStopped).not.toHaveBeenCalled();
        });

        it('should transition from compiling to done and set stoppedAt', async () => {
            mockDb.getSession.mockReturnValue(createMockSession('compiling'));

            await manager.transition('test-session-123', 'done');

            expect(mockDb.getSession).toHaveBeenCalledWith('test-session-123');
            expect(mockDb.updateSessionStatus).toHaveBeenCalledWith('test-session-123', 'done');
            expect(mockDb.updateSessionStopped).toHaveBeenCalledWith('test-session-123', expect.any(String));
        });

        it('should throw an error if the session does not exist', async () => {
            mockDb.getSession.mockReturnValue(null);

            await expect(manager.transition('non-existent', 'compiling')).rejects.toThrow('Session not found: non-existent');

            expect(mockDb.updateSessionStatus).not.toHaveBeenCalled();
        });

        it('should throw an error for invalid transition (recording -> done)', async () => {
            mockDb.getSession.mockReturnValue(createMockSession('recording'));

            await expect(manager.transition('test-session-123', 'done')).rejects.toThrow(
                'Invalid transition for session test-session-123: recording → done. Allowed: [compiling]'
            );

            expect(mockDb.updateSessionStatus).not.toHaveBeenCalled();
        });

        it('should throw an error for invalid transition (idle -> compiling)', async () => {
            mockDb.getSession.mockReturnValue(createMockSession('idle'));

            await expect(manager.transition('test-session-123', 'compiling')).rejects.toThrow(
                'Invalid transition for session test-session-123: idle → compiling. Allowed: [recording]'
            );

            expect(mockDb.updateSessionStatus).not.toHaveBeenCalled();
        });

        it('should throw an error for invalid transition (done -> recording)', async () => {
            mockDb.getSession.mockReturnValue(createMockSession('done'));

            await expect(manager.transition('test-session-123', 'recording')).rejects.toThrow(
                'Invalid transition for session test-session-123: done → recording. Allowed: [none]'
            );

            expect(mockDb.updateSessionStatus).not.toHaveBeenCalled();
        });
    });
});
