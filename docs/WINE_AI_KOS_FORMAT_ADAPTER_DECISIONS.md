# WINE AI KOS - Format Adapter Architecture & Dependency Decisions (Step 2B.1)

## Overview
This document records the exact dependency selections, security configurations, provenance models, and capability calculations for format adapters (`HTML`, `PDF`, `DOCX`) in WINE AI KOS.

---

## 1. Exact Installed Dependencies & Decision Matrix

| Format | Library Package | Exact Lockfile Version | License | Maintenance Status | Security Controls & Configuration |
| :--- | :--- | :--- | :--- | :--- | :--- |
| **HTML** | `cheerio` | `1.0.0` | MIT | Active | Zero JS execution, zero network requests, DOM node depth limits (`50`), `<script>`/`<style>` text stripping with logged format transformation. |
| **PDF** | `pdf-parse` | `2.4.5` | BSD-3-Clause / MIT | Active | Production PDF.js engine under the hood. Parses FlateDecode streams, ToUnicode CMaps, font encodings, indirect objects, and xref tables. Encrypted PDF detection (`KOS_PARSE_ENCRYPTED_PDF`), scanned PDF warning (`KOS_PDF_OCR_REQUIRED`). |
| **DOCX** | `adm-zip` + `@xmldom/xmldom` | `0.6.0` + `0.9.10` | MIT | Active | Production ZIP container extraction + W3C XML DOM parser with disabled DTD and external entities (XXE prevention). Cumulative uncompressed byte limits (`20MB`), per-entry expansion limits (`10x`), macro detection (`.docm` warning). |

---

## 2. Provenance Models by Format

### HTML Provenance
```json
{
  "representation": "canonical-v1",
  "utf16Start": 0,
  "utf16End": 25,
  "htmlLocation": {
    "nodeIndex": 1,
    "nodeType": "element",
    "tagName": "h1",
    "ancestorIndexes": [1],
    "sourceLocationStatus": "not_available",
    "sourceLine": null,
    "sourceColumn": null
  }
}
```

### PDF Provenance
```json
{
  "representation": "canonical-v1",
  "utf16Start": 0,
  "utf16End": 44,
  "pdfLocation": {
    "pageNumber": 1,
    "blockIndex": 1,
    "lineIndex": 1,
    "boundingBox": null
  }
}
```

### DOCX Provenance
```json
{
  "representation": "canonical-v1",
  "utf16Start": 0,
  "utf16End": 35,
  "docxLocation": {
    "paragraphIndex": 1,
    "tableIndex": null,
    "rowIndex": null,
    "cellIndex": null
  }
}
```

---

## 3. Dynamic Capability Calculation & Reasons

`ParsedDocument` does NOT return a static `capability: "full"`. Instead, `capability` is calculated dynamically:

* `capability: "full"`: Document parsed with full text and structural provenance, without warnings or layout uncertainties.
* `capability: "partial"`: Document parsed successfully, but contains warnings such as:
  * Scanned PDF without text layer (`KOS_PDF_OCR_REQUIRED`);
  * Complex multi-column PDF layout (`KOS_PDF_COMPLEX_LAYOUT`);
  * HTML script/style exclusion (`HTML_SCRIPT_ELEMENTS_EXCLUDED`);
  * DOCM macro-enabled file (`DOCM_MACROS_DECLARATION`).
* `capabilityReasons`: Array of strings explaining why `capability` is `partial` or `limited`.

---

## 4. Timeout Enforcement

All format parsing invocations enforce an orchestration-level timeout (`options.timeoutMs`, default 30,000ms). If parsing exceeds the limit, `parseDocument` rejects with `KosParserError('KOS_PARSE_TIMEOUT')`.
