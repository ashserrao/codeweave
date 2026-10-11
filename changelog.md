# Changelog

All Git commits and significant changes to this project. CodeWeave maintains the managed section below from Git history; entries are keyed and deduplicated by commit hash. Text outside the markers is never modified.

<!-- codeweave:begin changelog -->
## 2026-10-03

### v0.2.0: Phases 1–2 complete (foundation and resilience)
<!-- codeweave:commit 022663ad1052eb56c40f19037dcdfa0ca6e2b0d2 -->
- **`022663a`** CodeWeave v0.2.0: providers, streaming chat, usage tracking and context resilience (Anush Serrao)
  - **Phase 1, foundation:** OpenAI-compatible provider adapter with streaming, cancellation and idle timeout; error classification; provider/model/key registry with API keys in SecretStorage; priority routing with key rotation and provider fallback; chat sidebar with per-workspace history and editor context; Settings & Providers panel with presets and connection test.
  - **Phase 2, resilience:** usage ledger that keeps provider-reported and estimated tokens apart; rate-limit header capture and OpenRouter/DeepSeek balance checks; per-key token budgets; proactive cooldown when a provider reports an exhausted window; rolling conversation summaries from the local context model (Ollama `qwen2.5:3b`), with cloud providers never used for summarisation; continuation on the next key or provider after a mid-reply failure; one retry on context-length errors; usage dashboard and status bar item.
  - **Verification:** 44 automated tests; 24-check end-to-end run against mock cloud and local servers; manual testing in VS Code with NVIDIA and a local Ollama model.
<!-- codeweave:end changelog -->
