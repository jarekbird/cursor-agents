# Deployment Troubleshooting Guide

## SSH Connection Timeout Issues

If you see `dial tcp ***:22: i/o timeout`, this means GitHub Actions cannot establish an SSH connection to your server.

### Root Causes

1. **Server is unreachable from GitHub Actions runners**
   - GitHub Actions runners are in the cloud and may not have network access to your server
   - Your server might be behind a firewall or VPN

2. **Port 22 is blocked**
   - Firewall rules blocking SSH port
   - Security groups (AWS, GCP, Azure) not allowing port 22
   - ISP blocking port 22

3. **SSH service not running**
   - SSH daemon not started on the server
   - SSH service crashed or misconfigured

4. **Incorrect SSH credentials**
   - Wrong host/IP address in `SSH_HOST` secret
   - Wrong port in `SSH_PORT` secret
   - Invalid SSH private key in `SSH_PRIVATE_KEY` secret

### Diagnostic Steps

1. **Verify server is accessible:**
   ```bash
   # From your local machine
   ssh -v $SSH_USER@$SSH_HOST -p $SSH_PORT
   ```

2. **Check if SSH service is running:**
   ```bash
   # On the server
   sudo systemctl status ssh
   # or
   sudo systemctl status sshd
   ```

3. **Check firewall rules:**
   ```bash
   # On the server
   sudo ufw status
   # or
   sudo iptables -L -n
   ```

4. **Test port connectivity:**
   ```bash
   # From your local machine
   telnet $SSH_HOST $SSH_PORT
   # or
   nc -zv $SSH_HOST $SSH_PORT
   ```

5. **Verify GitHub Secrets:**
   - Go to repository Settings → Secrets and variables → Actions
   - Verify `SSH_HOST`, `SSH_USER`, `SSH_PRIVATE_KEY`, and `SSH_PORT` are set correctly
   - Ensure `SSH_HOST` is an IP address or resolvable hostname
   - Ensure `SSH_PRIVATE_KEY` is the full private key (including `-----BEGIN` and `-----END` lines)

### Solutions

#### Option 1: Use SSH Tunnel/Bastion Host
If your server is behind a firewall, use a bastion host:

```yaml
with:
  host: ${{ secrets.SSH_HOST }}
  username: ${{ secrets.SSH_USER }}
  key: ${{ secrets.SSH_PRIVATE_KEY }}
  port: ${{ secrets.SSH_PORT || 22 }}
  proxy_host: ${{ secrets.SSH_BASTION_HOST }}
  proxy_port: ${{ secrets.SSH_BASTION_PORT || 22 }}
  proxy_username: ${{ secrets.SSH_BASTION_USER }}
  proxy_key: ${{ secrets.SSH_BASTION_KEY }}
```

#### Option 2: Whitelist GitHub Actions IPs
GitHub Actions uses dynamic IPs. You can:
- Use GitHub's IP ranges (not recommended - too broad)
- Use a VPN or bastion host
- Allow all IPs temporarily for testing (not recommended for production)

#### Option 3: Use GitHub Self-Hosted Runner
Deploy a self-hosted runner on your network that can access the server:

1. Set up a GitHub Actions self-hosted runner on a machine in your network
2. Configure the workflow to use the self-hosted runner:
   ```yaml
   jobs:
     deploy:
       runs-on: self-hosted  # or your runner label
   ```

#### Option 4: Use Alternative Deployment Method
Instead of SSH, consider:
- Docker Hub/Registry + webhook to trigger deployment on server
- CI/CD pipeline that pushes to a deployment branch
- Kubernetes/Docker Swarm with webhook triggers

### Current Workflow Configuration

The workflow is configured with:
- `timeout: 120s` - Connection timeout (increased from 60s)
- `command_timeout: 15m` - Maximum time for script execution

If timeouts persist, the issue is network connectivity, not timeout duration.

### Quick Test

To verify if the issue is network-related:

1. **Test from GitHub Actions:**
   Add a test step before deployment:
   ```yaml
   - name: Test SSH connection
     run: |
       timeout 5 ssh -o StrictHostKeyChecking=no \
         -i <(echo "${{ secrets.SSH_PRIVATE_KEY }}") \
         ${{ secrets.SSH_USER }}@${{ secrets.SSH_HOST }} \
         -p ${{ secrets.SSH_PORT || 22 }} \
         "echo 'Connection successful'" || echo "Connection failed"
   ```

2. **Check server logs:**
   On your server, check SSH logs:
   ```bash
   sudo tail -f /var/log/auth.log
   # or
   sudo journalctl -u ssh -f
   ```

### Next Steps

1. Verify server is accessible from the internet
2. Check firewall/security group rules
3. Verify SSH service is running
4. Test SSH connection manually with the same credentials
5. Consider using a self-hosted runner or bastion host

