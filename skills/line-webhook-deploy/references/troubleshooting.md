# Troubleshooting Guide

## Webhook Issues

### "Callback URL verification failed" in LINE Console

**Symptoms:** LINE Console shows verification failed when setting webhook URL.

**Solutions:**
1. Check ngrok is running: `docker-compose ps ngrok`
2. Get current URL: `curl http://localhost:4040/api/tunnels`
3. Ensure URL ends with `/webhook`
4. Check webhook logs: `docker-compose logs webhook`
5. Verify LINE credentials are correct in `.env`

### Not receiving messages

**Checklist:**
- [ ] Webhook URL is set in LINE Console
- [ ] "Use webhook" is enabled
- [ ] Auto-reply keywords are configured
- [ ] Check firewall (port 4040 for ngrok dashboard)

**Debug commands:**
```bash
# Check service status
docker-compose ps

# View webhook logs
docker-compose logs -f webhook

# Test health endpoint
curl http://localhost:3000/health
```

## Database Issues

### "Access denied for user"

**Cause:** MySQL credentials in `.env` don't match.

**Fix:**
```bash
# Stop and remove volumes (WARNING: data loss)
docker-compose down -v

# Update .env with correct passwords
# Restart
docker-compose up -d
```

### Connection refused

**Check:**
```bash
# MySQL health
docker-compose exec mysql mysqladmin ping

# Check port binding
docker-compose ps mysql
```

## RAG/Vector Search Issues

### No search results

**Check:**
1. Documents exist in `knowledge/` directory
2. Indexer processed files: `docker-compose logs indexer`
3. Qdrant is running: `curl http://localhost:6333/collections/knowledge_base`

**Re-index documents:**
```bash
# Restart indexer to force re-scan
docker-compose restart indexer
```

### "Collection not found"

**Fix:**
```bash
# Create collection manually
curl -X PUT http://localhost:6333/collections/knowledge_base \
  -H "Content-Type: application/json" \
  -d '{"vectors":{"size":1536,"distance":"Cosine"}}'
```

## LLM Issues

### "Authentication error"

**Check:**
- API key is correct
- Base URL matches provider
- Model name is valid

**Test configuration:**
```bash
docker-compose exec webhook node -e "
const axios = require('axios');
axios.post(process.env.OPENAI_BASE_URL + '/chat/completions', {
    model: process.env.LLM_MODEL,
    messages: [{role: 'user', content: 'Hi'}]
}, {
    headers: { 'Authorization': 'Bearer ' + process.env.OPENAI_API_KEY }
}).then(r => console.log('OK'))
.catch(e => console.error(e.response?.data || e.message));
"
```

### Timeout errors

**Solutions:**
1. Use faster model (e.g., `moonshot-v1-8k` vs `128k`)
2. Reduce `max_rag_results` in settings
3. Check network connectivity to LLM provider

## ngrok Issues

### "Tunnel session expired"

Free ngrok tunnels expire after ~2 hours.

**Solutions:**
- Restart ngrok: `docker-compose restart ngrok`
- Update LINE Console with new URL
- Consider paid ngrok plan for static URLs

### "Failed to establish connection"

**Check:**
```bash
# ngrok status
curl http://localhost:4040/api/status

# Auth token validity
docker-compose logs ngrok | grep -i auth
```

## Performance Issues

### Slow response times

**Optimize:**
1. Reduce RAG results: Update `max_rag_results` to 3
2. Use faster LLM model
3. Pre-compute owner style analysis
4. Enable MySQL query cache (for older MySQL versions)

**Monitor:**
```bash
# Check auto-reply latency
docker-compose exec mysql mysql -e "
SELECT 
    AVG(retrieval_time_ms) as avg_retrieval,
    AVG(generation_time_ms) as avg_generation
FROM t_auto_replies;
"
```

## Data Recovery

### Restore from backup

MySQL data volume:
```bash
# Backup
docker run --rm -v line-webhook_mysql-data:/data -v $(pwd):/backup alpine tar czf /backup/mysql-backup.tar.gz -C /data .

# Restore
docker run --rm -v line-webhook_mysql-data:/data -v $(pwd):/backup alpine sh -c "cd /data && tar xzf /backup/mysql-backup.tar.gz"
```
