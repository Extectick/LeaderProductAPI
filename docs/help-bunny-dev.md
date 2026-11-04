# Bunny dev Help assistant

Bunny is an opt-in test provider for the existing durable Help queue. It is enabled only when `NODE_ENV=development`, `HELP_AI_ENABLED=true`, `HELP_AI_PROVIDER=bunny`, `HELP_BUNNY_DEV_ENABLED=true`, and a server-side CHAT key is configured. Production refuses Bunny even if flags/key are supplied. The model/origin are fixed to `bunny-qwen3.5-4b` and `https://ai.bunny.ge/api/v1/chat/completions`; redirects are refused.

Set `BUNNY_CHAT_API_KEY` or `BUNNY_CHAT_API_KEY_FILE` in API and worker only. A file takes precedence. The development GitHub Environment needs the encrypted `BUNNY_CHAT_API_KEY` secret. Never place keys in APP or public environment variables. The private source contract is `/workspace/ai-integration-dev.md`; do not commit it.

The provider supplies a Russian support prompt and a small window of this ticket's owner/system text messages. It does not send attachments, signed URLs, knowledge documents or 1C data and has no tools. These limitations are explicit in its prompt. This test provider suggests general diagnostics and clarifying questions; existing IT controls hand off the ticket. The production OpenAI/knowledge paths are unchanged.

Inference happens in the worker, outside the message acceptance transaction. Existing lease fencing, Stop, superseding messages and IT handoff prevent late answers from being committed. Response bodies are bounded, unfinished/tool/reasoning-only responses are rejected, context overflow gets one smaller-context retry, transient errors enter the bounded durable retry queue. No provider bodies or keys are logged.

## Deploy

1. Run TypeScript, Bunny/Help unit tests and `python3 scripts/test_deploy_server_api.py`.
2. Push reviewed dev commit; await successful `Build & Deploy API` for that exact SHA.
3. Dispatch the existing `Build & Deploy API` workflow from dev with `bunny_help_bind=true` (and `deploy=false`) at the same SHA. This invokes `Bind Bunny Help AI (dev only)` without rebuilding; the wrapper is needed when the new workflow is not registered on the default branch. It uses the development environment and the existing release runner/lock; refuses other hosts, databases, runtime modes or mismatched API images. It verifies the Help schema without migrations, configures API and dedicated worker, probes real inference and checks unrelated containers remain unchanged.
4. Private binding is persisted as `/opt/leader-api-dev/help-bunny.private.json` with mode 0600, outside the repository. Subsequent dev API releases retain the binding and update API/worker together; prod releases ignore it. A failed activation restores prior Compose and stops/removes a newly created worker; image releases retain their existing backup/rollback flow.
5. Validate an actual reply, Stop and IT handoff in an authorized dev QA ticket. A successful health or direct inference probe alone does not prove the chat flow.

No database schema changes, APP update, APK or OTA are required.
