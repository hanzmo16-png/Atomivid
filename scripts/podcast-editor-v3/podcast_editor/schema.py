"""Tiny JSON Schema (draft 2020-12 subset) validator, stdlib only.

Supports exactly the keywords used by docs/montaje.schema.json: type, enum, const, properties,
patternProperties, additionalProperties, required, items, minItems, maxItems, minimum, maximum,
exclusiveMinimum, exclusiveMaximum, minLength, pattern, anyOf, oneOf, allOf, not, if/then/else,
$ref (local '#/$defs/...'). Unknown keywords are ignored (annotations such as description)."""
from __future__ import annotations

import json
import re
from pathlib import Path

SCHEMA_PATH = Path(__file__).resolve().parents[1] / "docs" / "montaje.schema.json"
_TYPES = {"object": dict, "array": list, "string": str, "boolean": bool, "null": type(None)}


def _is_type(v, t):
    if t == "integer":
        return isinstance(v, int) and not isinstance(v, bool)
    if t == "number":
        return isinstance(v, (int, float)) and not isinstance(v, bool)
    return isinstance(v, _TYPES[t])


class Validator:
    def __init__(self, schema: dict):
        self.root = schema

    def _ref(self, ref):
        if not ref.startswith("#/"):
            raise ValueError(f"only local $ref supported: {ref}")
        node = self.root
        for part in ref[2:].split("/"):
            node = node[part]
        return node

    def errors(self, inst, schema=None, path="$") -> list[str]:
        s = self.root if schema is None else schema
        if s is True or s == {}:
            return []
        if s is False:
            return [f"{path}: not allowed"]
        out: list[str] = []
        if "$ref" in s:
            out += self.errors(inst, self._ref(s["$ref"]), path)
        if "type" in s:
            ts = s["type"] if isinstance(s["type"], list) else [s["type"]]
            if not any(_is_type(inst, t) for t in ts):
                return out + [f"{path}: expected {'/'.join(ts)}, got {type(inst).__name__}"]
        if "const" in s and inst != s["const"]:
            out.append(f"{path}: must be {json.dumps(s['const'], ensure_ascii=False)}")
        if "enum" in s and inst not in s["enum"]:
            out.append(f"{path}: must be one of {json.dumps(s['enum'], ensure_ascii=False)}")
        if isinstance(inst, (int, float)) and not isinstance(inst, bool):
            if "minimum" in s and inst < s["minimum"]:
                out.append(f"{path}: must be >= {s['minimum']}")
            if "maximum" in s and inst > s["maximum"]:
                out.append(f"{path}: must be <= {s['maximum']}")
            if "exclusiveMinimum" in s and inst <= s["exclusiveMinimum"]:
                out.append(f"{path}: must be > {s['exclusiveMinimum']}")
            if "exclusiveMaximum" in s and inst >= s["exclusiveMaximum"]:
                out.append(f"{path}: must be < {s['exclusiveMaximum']}")
        if isinstance(inst, str):
            if "minLength" in s and len(inst) < s["minLength"]:
                out.append(f"{path}: shorter than {s['minLength']}")
            if "pattern" in s and not re.search(s["pattern"], inst):
                out.append(f"{path}: {inst!r} does not match {s['pattern']}")
        if isinstance(inst, list):
            if "minItems" in s and len(inst) < s["minItems"]:
                out.append(f"{path}: needs at least {s['minItems']} items")
            if "maxItems" in s and len(inst) > s["maxItems"]:
                out.append(f"{path}: at most {s['maxItems']} items")
            if "items" in s:
                for i, v in enumerate(inst):
                    out += self.errors(v, s["items"], f"{path}[{i}]")
        if isinstance(inst, dict):
            for k in s.get("required", []):
                if k not in inst:
                    out.append(f"{path}: missing required '{k}'")
            props, pats = s.get("properties", {}), s.get("patternProperties", {})
            for k, v in inst.items():
                matched = False
                if k in props:
                    matched = True
                    out += self.errors(v, props[k], f"{path}.{k}")
                for pat, sub in pats.items():
                    if re.search(pat, k):
                        matched = True
                        out += self.errors(v, sub, f"{path}.{k}")
                if not matched and "additionalProperties" in s:
                    ap = s["additionalProperties"]
                    if ap is False:
                        out.append(f"{path}: unknown key '{k}'")
                    elif isinstance(ap, dict):
                        out += self.errors(v, ap, f"{path}.{k}")
        for sub in s.get("allOf", []):
            out += self.errors(inst, sub, path)
        if "anyOf" in s and not any(not self.errors(inst, sub, path) for sub in s["anyOf"]):
            out.append(f"{path}: does not match any allowed form")
        if "oneOf" in s:
            n = sum(1 for sub in s["oneOf"] if not self.errors(inst, sub, path))
            if n != 1:
                detail = "; ".join(e for sub in s["oneOf"] for e in self.errors(inst, sub, path)[:1])
                out.append(f"{path}: must match exactly one allowed form (matched {n}): {detail}")
        if "not" in s and not self.errors(inst, s["not"], path):
            out.append(f"{path}: matches a forbidden form")
        if "if" in s:
            if not self.errors(inst, s["if"], path):
                if "then" in s:
                    out += self.errors(inst, s["then"], path)
            elif "else" in s:
                out += self.errors(inst, s["else"], path)
        return out


def validate_manifest(obj, schema_path: Path = SCHEMA_PATH) -> list[str]:
    return Validator(json.loads(Path(schema_path).read_text(encoding="utf-8"))).errors(obj)
