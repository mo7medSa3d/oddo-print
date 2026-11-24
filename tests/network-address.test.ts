import { describe, expect, it } from "vitest";
import { isPrivateNetworkAddress } from "../src/lib/network-address";

describe("isPrivateNetworkAddress", () => {
  it("accepts intended private and link-local IPv4 ranges", () => {
    expect(isPrivateNetworkAddress("10.0.0.10")).toBe(true);
    expect(isPrivateNetworkAddress("172.16.10.10")).toBe(true);
    expect(isPrivateNetworkAddress("192.168.1.10")).toBe(true);
    expect(isPrivateNetworkAddress("169.254.10.10")).toBe(true);
  });

  it("rejects cloud metadata endpoints even inside private/link-local ranges", () => {
    expect(isPrivateNetworkAddress("169.254.169.254")).toBe(false);
    expect(isPrivateNetworkAddress("169.254.170.2")).toBe(false);
    expect(isPrivateNetworkAddress("fd00:0ec2:0000:0000:0000:0000:0000:0254")).toBe(false);
    expect(isPrivateNetworkAddress("fd00:ec2::254")).toBe(false);
  });

  it("rejects public and loopback IPv4", () => {
    expect(isPrivateNetworkAddress("8.8.8.8")).toBe(false);
    expect(isPrivateNetworkAddress("127.0.0.1")).toBe(false);
    expect(isPrivateNetworkAddress("172.15.255.255")).toBe(false);
    expect(isPrivateNetworkAddress("192.0.2.1")).toBe(false);
  });

  it("accepts IPv6 ULA and link-local addresses", () => {
    expect(isPrivateNetworkAddress("fc00::1")).toBe(true);
    expect(isPrivateNetworkAddress("fd12:3456:789a::1")).toBe(true);
    expect(isPrivateNetworkAddress("fe80::1")).toBe(true);
  });

  it("rejects public, loopback, multicast, unspecified and zoned IPv6", () => {
    expect(isPrivateNetworkAddress("2001:4860:4860::8888")).toBe(false);
    expect(isPrivateNetworkAddress("::1")).toBe(false);
    expect(isPrivateNetworkAddress("ff02::1")).toBe(false);
    expect(isPrivateNetworkAddress("::")).toBe(false);
    expect(isPrivateNetworkAddress("fe80::1%eth0")).toBe(false);
  });
});
