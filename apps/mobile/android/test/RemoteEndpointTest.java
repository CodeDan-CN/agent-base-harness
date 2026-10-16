package com.agentharness.mobile;

import java.net.URI;

public final class RemoteEndpointTest {
    public static void main(String[] args) throws Exception {
        for (String valid : new String[] {"https://example.com", "https://example.com/runtime/", "http://10.0.2.2:4317", "http://192.168.1.10:4317", "http://172.16.0.1"}) RemoteEndpoint.parse(valid);
        for (String invalid : new String[] {"http://example.com", "http://8.8.8.8", "http://172.32.0.1", "http://127.0.0.1", "https://localhost", "https://a:b@example.com", "https://example.com?a=b", "https://example.com/#x", "https://example.com/a/../b", "https://example.com/%2e", "http://10.1.2.999", "https://example.com:65536", "file:///tmp/a"}) {
            boolean rejected = false;
            try { RemoteEndpoint.parse(invalid); } catch (Exception error) { rejected = true; }
            if (!rejected) throw new AssertionError("Accepted invalid server: " + invalid);
        }
        if (!RemoteEndpoint.allowedHeader("x-agent-user") || !RemoteEndpoint.allowedHeader("x-agent-client-kind")) throw new AssertionError("Identity headers blocked");
        if (RemoteEndpoint.allowedHeader("authorization") || RemoteEndpoint.allowedHeader("host")) throw new AssertionError("Unexpected header accepted");
        URI base = RemoteEndpoint.parse("https://example.com/runtime");
        if (!RemoteEndpoint.route(base, new URI("https://example.com/runtime/v1/sessions/abc-123/events?afterSeq=2")).endsWith("/events")) throw new AssertionError();
        for (String target : new String[] {"https://example.com/runtime/v1/auth/login", "https://evil.test/runtime/healthz", "https://example.com/runtime/v1/server/stop", "https://example.com/runtime/../healthz", "https://example.com/healthz", "https://example.com/runtime/v1/sessions/%2e%2e/events", "http://example.com/runtime/healthz"}) {
            boolean rejected = false;
            try { RemoteEndpoint.route(base, new URI(target)); } catch (Exception error) { rejected = true; }
            if (!rejected) throw new AssertionError("Accepted invalid request: " + target);
        }
        System.out.println("[mobile-policy] HTTPS/LAN authority, private IPv4, traversal, origin and API allowlist passed");
    }
}
