# Traefik Configuration for cursor-agents

This document describes how the `cursor-agents` application is exposed via Traefik reverse proxy.

## Overview

The `cursor-agents` service is configured to be accessible via HTTPS through Traefik, which is defined in the `cursor-runner/docker-compose.yml` file. Both services share the same `virtual-assistant-network` Docker network.

## Configuration

### Domain Access

The service uses **path-based routing** on the same domain as `jarek-va`:
- **Base URL**: `https://${DOMAIN_NAME}/agents`
- **HTTP**: Automatically redirects to HTTPS

The `DOMAIN_NAME` environment variable should be set in your deployment environment (same as used for `jarek-va`).

**Example**: If your domain is `n8n.srv1099656.hstgr.cloud`, the service will be at:
- `https://n8n.srv1099656.hstgr.cloud/agents`

### Available Endpoints

Once deployed, the following endpoints will be accessible:

1. **API Endpoints**:
   - `https://${DOMAIN_NAME}/agents/health` - Health check
   - `https://${DOMAIN_NAME}/agents/queues` - List queues
   - `https://${DOMAIN_NAME}/agents/prompts/recurring` - Manage recurring prompts
   - `https://${DOMAIN_NAME}/agents/prompts/:name` - Get/delete prompt status

2. **Bull Board Dashboard**:
   - `https://${DOMAIN_NAME}/agents/admin/queues` - **Queue monitoring dashboard** (similar to Sidekiq Web UI)

### Security Features

The Traefik configuration includes:
- **SSL/TLS**: Automatic HTTPS with Let's Encrypt certificates
- **Security Headers**: 
  - HSTS (HTTP Strict Transport Security)
  - SSL redirect
  - Preload enabled
- **HTTPS Only**: HTTP traffic automatically redirects to HTTPS

## Network Configuration

Both `cursor-agents` and other services use the same external network:
- **Network Name**: `virtual-assistant-network`
- **Type**: External (created separately, shared across services)

This allows:
- `cursor-agents` to connect to Redis (defined in `cursor-runner/docker-compose.yml`)
- `cursor-agents` to connect to `cursor-runner` service
- Traefik to route traffic to `cursor-agents`

## Deployment

### Prerequisites

1. Ensure Traefik is running (defined in `cursor-runner/docker-compose.yml`)
2. Ensure the `virtual-assistant-network` network exists:
   ```bash
   docker network create virtual-assistant-network
   ```
3. Set the `DOMAIN_NAME` environment variable (same as used for `jarek-va`)

### Deploying

```bash
cd cursor-agents
docker compose up -d
```

### Verifying

1. Check service is running:
   ```bash
   docker ps | grep cursor-agents
   ```

2. Check Traefik has detected the service:
   - Access Traefik dashboard at `http://localhost:8080` (or your server IP)
   - Look for `cursor-agents` in the HTTP routers section

3. Test HTTPS access:
   ```bash
   curl -k https://${DOMAIN_NAME}/agents/health
   ```

4. Access Bull Board dashboard:
   - Open browser: `https://${DOMAIN_NAME}/agents/admin/queues`
   - You should see the BullMQ queue monitoring interface

## DNS Configuration

**No DNS changes needed!** This configuration uses path-based routing on the same domain as `jarek-va`, so you don't need to create any DNS records. The service will be accessible at `/agents` on your existing domain.

## Troubleshooting

### Service not accessible

1. **Check Traefik is running**:
   ```bash
   docker ps | grep traefik
   ```

2. **Check network connectivity**:
   ```bash
   docker network inspect virtual-assistant-network
   ```
   Should show both `cursor-agents` and `virtual-assistant-traefik`

3. **Check Traefik logs**:
   ```bash
   docker logs virtual-assistant-traefik
   ```

4. **Check cursor-agents logs**:
   ```bash
   docker logs cursor-agents
   ```

### SSL Certificate Issues

- Ensure `DOMAIN_NAME` is set correctly
- Check Let's Encrypt rate limits (if testing frequently)
- Verify DNS A record is pointing to your server
- Check Traefik logs for ACME challenge errors

### Dashboard not loading

- Verify the service is running: `docker ps | grep cursor-agents`
- Check application logs: `docker logs cursor-agents`
- Verify the route: `https://agents.${DOMAIN_NAME}/admin/queues`
- Check browser console for errors

## Related Services

- **Traefik**: Defined in `cursor-runner/docker-compose.yml`
- **Redis**: Defined in `cursor-runner/docker-compose.yml`, shared with `cursor-agents`
- **cursor-runner**: Should also be on `virtual-assistant-network` for internal communication

