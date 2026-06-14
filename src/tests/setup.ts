/**
 * Test setup: mock Supabase client for unit tests
 * In real usage, point to a test database instance
 */

import { vi, beforeEach, afterEach } from 'vitest';

// Mock Supabase client
export const mockDb = {
  from: vi.fn((table: string) => ({
    select: vi.fn().mockReturnThis(),
    insert: vi.fn().mockReturnThis(),
    update: vi.fn().mockReturnThis(),
    delete: vi.fn().mockReturnThis(),
    eq: vi.fn().mockReturnThis(),
    lt: vi.fn().mockReturnThis(),
    lte: vi.fn().mockReturnThis(),
    gt: vi.fn().mockReturnThis(),
    gte: vi.fn().mockReturnThis(),
    in: vi.fn().mockReturnThis(),
    not: vi.fn().mockReturnThis(),
    single: vi.fn().mockResolvedValue({ data: null, error: null }),
    limit: vi.fn().mockReturnThis(),
    where: vi.fn().mockReturnThis(),
    order: vi.fn().mockReturnThis(),
    upsert: vi.fn().mockReturnThis(),
    match: vi.fn().mockReturnThis(),
  })),
  rpc: vi.fn(),
};

export const setupTestDb = () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.clearAllMocks();
  });
};

/**
 * For integration tests with real database:
 * 1. Create a Supabase project for testing
 * 2. Set SUPABASE_URL and SUPABASE_ANON_KEY env vars
 * 3. Run migrations against test database
 * 4. Replace mockDb with real client
 */
