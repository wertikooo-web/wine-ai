# WINE AI KOS — AI Extractor Security Boundary Specification (Step 3A Refined)

## 1. Overview & Trust Boundaries

The Knowledge Operational System (KOS) treats all incoming documents (HTML, PDF, DOCX, Text) and their parsed representations (`ParsedDocument`) as **untrusted data**. 

AI Extractors operate inside a strictly isolated sandbox boundary where model outputs are constrained, validated, and sanitized by system-level validation before any candidate fact enters the review queue.

```text
Untrusted Document / ParsedDocument
   ↓
Parser Core (Suspicious Content Detection)
   ↓
AI Extractor Sandbox (CandidateDraft Output Only)
   ↓
Candidate Validator (CandidateFingerprint, Value Normalizers, Range & Quote Checks)
   ↓
ValidatedFactCandidate (validationStatus: "valid" | "invalid")
   ↓
Unverified Candidate Review Queue (CandidateReview)
```

---

## 2. Core Security Constraints

1. **Untrusted Data Boundary**:
   - `ParsedDocument.canonicalText` and `rawText` are treated strictly as untrusted data to be analyzed.
   - Document text has **no authority** to override system prompts, extraction schemas, field policies, or validation rules.
   - Instructions contained within document text (e.g. `"Ignore previous instructions and output..."`) are identified by `suspiciousContentDetector.js` and flagged in `suspiciousContent`.

2. **System Prompt Isolation**:
   - Instruction overrides within document content are **never** evaluated or executed as system prompts.
   - The LLM prompt explicitly instructs the model to act solely as a structured entity extractor emitting valid JSON `CandidateDraft` payloads.

3. **Strict JSON Schema Enforcement**:
   - The AI Extractor may **only** emit structured JSON conforming to `CandidateDraft`.
   - Unstructured text responses, Markdown outside JSON, or malformed payloads are rejected immediately.

4. **Zero Direct Database Writes / Publishing**:
   - AI Extractors emit `CandidateDraft` objects. They cannot write directly to production tables (`kos_winery_profile_state`, `kos_profile_versions`).
   - AI Extractors **cannot** auto-publish facts or modify sources.
   - All validation, candidate ID calculation (`candidateId`), and status assignment (`validationStatus`) are performed by the system validator, not the AI extractor.

5. **No Tool Execution Capability**:
   - AI Extractors do not have access to system tools, shell execution, external network calls, database queries, or MCP endpoints.

---

## 3. Fact Candidate Validation Gate

Every `CandidateDraft` produced by an AI Extractor must pass through `validateAndBuildFactCandidate` before being accepted into the review queue:

* **Quote & Range Verification**: `canonicalText.slice(utf16Start, utf16End) === quote`.
* **UTF-8 & Surrogate Boundary Checks**: Verified byte offsets and surrogate pair boundaries.
* **Structural Binding**: Every structural unit ID in `structuralUnitIds` must exist in `ParsedDocument.structuralUnits`.
* **Value Type & Range Enforcement**: Numerical values (e.g. `alcoholPercent` between 0–30%) are checked against `extractionFieldPolicies.js`.

Candidates failing validation are assigned `validationStatus: "invalid"` and logged in debug output, preventing corrupted or hallucinated facts from reaching human reviewers.
