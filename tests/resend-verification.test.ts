import { describe, it, expect, vi, beforeEach } from "vitest";

const userFindFirst = vi.fn();
const executeMock = vi.fn();
const transactionMock = vi.fn();
const updateMock = vi.fn();
const insertMock = vi.fn();
const sendEmailMock = vi.fn();

vi.mock("../src/db", () => ({
  db: {
    query: {
      users: {
        findFirst: (...args: unknown[]) => userFindFirst(...args),
      },
    },
    transaction: (cb: (tx: unknown) => Promise<unknown>) => transactionMock(cb),
    execute: (...args: unknown[]) => executeMock(...args),
  },
}));

vi.mock("../src/lib/email", () => ({
  sendTransactionalEmail: (...args: unknown[]) => sendEmailMock(...args),
  appBaseUrl: () => "http://localhost:3000",
}));

vi.mock("../src/lib/auth-rate-limit", () => ({
  clientIpFrom: () => "127.0.0.1",
  reserveAuthAttempt: vi.fn().mockResolvedValue({ allowed: true }),
  setRateLimitHeaders: (response: Response) => response,
}));

import { POST } from "../src/app/api/auth/resend-verification/route";

describe("Resend Email Verification API", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("returns 400 for invalid email", async () => {
    const req = new Request("http://localhost/api/auth/resend-verification", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email: "not-an-email" }),
    });
    const res = await POST(req);
    expect(res.status).toBe(400);
  });

  it("returns 202 anti-enumeration response if user not found", async () => {
    userFindFirst.mockResolvedValue(null);
    const req = new Request("http://localhost/api/auth/resend-verification", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email: "unknown@example.com" }),
    });
    const res = await POST(req);
    expect(res.status).toBe(202);
    const data = await res.json();
    expect(data.ok).toBe(true);
    expect(sendEmailMock).not.toHaveBeenCalled();
  });

  it("returns 202 anti-enumeration response if user already verified", async () => {
    userFindFirst.mockResolvedValue({ id: "usr_1", emailVerifiedAt: new Date() });
    const req = new Request("http://localhost/api/auth/resend-verification", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email: "verified@example.com" }),
    });
    const res = await POST(req);
    expect(res.status).toBe(202);
    const data = await res.json();
    expect(data.ok).toBe(true);
    expect(sendEmailMock).not.toHaveBeenCalled();
  });

  it("rechecks verification state under the user lock before minting", async () => {
    userFindFirst.mockResolvedValue({ id: "usr_race", emailVerifiedAt: null });
    transactionMock.mockImplementation(async (cb) => {
      return cb({
        execute: executeMock.mockResolvedValue({
          rows: [{ id: "usr_race", emailVerifiedAt: new Date() }],
        }),
        update: updateMock,
        insert: insertMock,
      });
    });

    const req = new Request("http://localhost/api/auth/resend-verification", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email: "race@example.com" }),
    });
    const res = await POST(req);
    expect(res.status).toBe(202);
    expect(insertMock).not.toHaveBeenCalled();
    expect(sendEmailMock).not.toHaveBeenCalled();
  });

  it("invalidates previous tokens and dispatches new email for unverified user", async () => {
    userFindFirst.mockResolvedValue({ id: "usr_unverified", emailVerifiedAt: null });
    const txUpdateWhere = vi.fn().mockResolvedValue(undefined);
    const txUpdateSet = vi.fn().mockReturnValue({ where: txUpdateWhere });
    const txUpdate = vi.fn().mockReturnValue({ set: txUpdateSet });
    const txInsertValues = vi.fn().mockResolvedValue(undefined);
    const txInsert = vi.fn().mockReturnValue({ values: txInsertValues });

    transactionMock.mockImplementation(async (cb) => {
      return cb({
        execute: executeMock.mockResolvedValue({ rows: [{ id: "usr_unverified", emailVerifiedAt: null }] }),
        update: txUpdate,
        insert: txInsert,
      });
    });
    sendEmailMock.mockResolvedValue(undefined);

    const req = new Request("http://localhost/api/auth/resend-verification", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email: "user@example.com" }),
    });
    const res = await POST(req);
    expect(res.status).toBe(202);
    expect(txUpdate).toHaveBeenCalled();
    expect(txInsert).toHaveBeenCalled();
    expect(sendEmailMock).toHaveBeenCalledWith(
      expect.objectContaining({
        to: "user@example.com",
        subject: "Verify your Yasser account",
      })
    );
  });
});
