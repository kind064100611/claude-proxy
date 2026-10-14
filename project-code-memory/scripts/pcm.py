#!/usr/bin/env python3
"""Compact, fingerprint-validated, self-pruning project code memory."""

from __future__ import annotations

import argparse
import hashlib
import json
import os
import re
import sys
import tempfile
import time
from contextlib import contextmanager
from pathlib import Path
from typing import Any, Iterable, Iterator


MEMORY_DIR = "projectCodeMemory"
IGNORE_RULE = f"/{MEMORY_DIR}/"
INDEX_HEADER = "#pcm-v1\n#id\tkeywords\tpaths\tsymbols\tsummary\n"
ID_PATTERN = re.compile(r"^[a-z0-9][a-z0-9._-]{0,79}$")
TOKEN_PATTERN = re.compile(r"[\w./:#-]+", re.UNICODE)
WORD_PATTERN = re.compile(r"[^\W_]+", re.UNICODE)
SIMILARITY_THRESHOLD = 0.90
MIN_STRUCTURE_SIZE_RATIO = 0.50
MIN_CONTENT_SIMILARITY = 0.50
LOCK_TIMEOUT_SECONDS = 10.0
LOCK_RETRY_SECONDS = 0.05
MAX_LOCATIONS_PER_SYMBOL = 5
MAX_SYMBOLS_TO_LOCATE = 50
MAX_LOCATION_ERRORS = 10


class MemoryError(ValueError):
    pass


def _acquire_file_lock(handle: Any) -> None:
    handle.seek(0)
    if os.name == "nt":
        import msvcrt

        msvcrt.locking(handle.fileno(), msvcrt.LK_NBLCK, 1)
    else:
        import fcntl

        fcntl.flock(handle.fileno(), fcntl.LOCK_EX | fcntl.LOCK_NB)


def _release_file_lock(handle: Any) -> None:
    handle.seek(0)
    if os.name == "nt":
        import msvcrt

        msvcrt.locking(handle.fileno(), msvcrt.LK_UNLCK, 1)
    else:
        import fcntl

        fcntl.flock(handle.fileno(), fcntl.LOCK_UN)


@contextmanager
def memory_lock(root: Path, timeout: float = LOCK_TIMEOUT_SECONDS) -> Iterator[None]:
    memory = root / MEMORY_DIR
    memory.mkdir(parents=True, exist_ok=True)
    lock_path = memory / ".lock"
    try:
        handle = lock_path.open("a+b")
    except OSError as exc:
        raise MemoryError(f"cannot open memory lock {lock_path}: {exc}") from exc

    acquired = False
    try:
        handle.seek(0, os.SEEK_END)
        if handle.tell() == 0:
            handle.write(b"0")
            handle.flush()
        deadline = time.monotonic() + max(0.0, timeout)
        while True:
            try:
                _acquire_file_lock(handle)
                acquired = True
                break
            except OSError as exc:
                if time.monotonic() >= deadline:
                    raise MemoryError(f"timed out waiting for memory lock {lock_path}") from exc
                time.sleep(LOCK_RETRY_SECONDS)
        yield
    finally:
        if acquired:
            try:
                _release_file_lock(handle)
            except OSError:
                pass
        handle.close()


def atomic_write(path: Path, content: str) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    descriptor = -1
    temporary: Path | None = None
    try:
        descriptor, temporary_name = tempfile.mkstemp(
            prefix=f".{path.name}.", suffix=".tmp", dir=path.parent
        )
        temporary = Path(temporary_name)
        with os.fdopen(descriptor, "w", encoding="utf-8", newline="") as destination:
            descriptor = -1
            destination.write(content)
            destination.flush()
            os.fsync(destination.fileno())
        os.replace(temporary, path)
    except OSError as exc:
        raise MemoryError(f"cannot atomically write {path}: {exc}") from exc
    finally:
        if descriptor >= 0:
            os.close(descriptor)
        if temporary is not None:
            try:
                temporary.unlink(missing_ok=True)
            except OSError:
                pass


def resolve_root(value: str) -> Path:
    root = Path(value).expanduser().resolve()
    if not root.is_dir():
        raise MemoryError(f"repository root is not a directory: {root}")
    return root


def memory_paths(root: Path) -> tuple[Path, Path, Path]:
    memory = root / MEMORY_DIR
    return memory, memory / "index.tsv", memory / "records"


def ensure_ignored(root: Path) -> None:
    gitignore = root / ".gitignore"
    if gitignore.exists() and not gitignore.is_file():
        raise MemoryError(f".gitignore is not a file: {gitignore}")
    try:
        content = gitignore.read_text(encoding="utf-8") if gitignore.exists() else ""
        if IGNORE_RULE in content.splitlines():
            return
        with gitignore.open("a", encoding="utf-8") as destination:
            if content and not content.endswith(("\n", "\r")):
                destination.write("\n")
            destination.write(f"{IGNORE_RULE}\n")
    except OSError as exc:
        raise MemoryError(f"cannot ensure ignore rule in {gitignore}: {exc}") from exc
    print(f"IGNORED {gitignore}")


def _init_memory(root: Path, announce: bool = True) -> None:
    memory, index, records = memory_paths(root)
    records.mkdir(parents=True, exist_ok=True)
    (memory / "drafts").mkdir(parents=True, exist_ok=True)
    if not index.exists():
        atomic_write(index, INDEX_HEADER)
    ensure_ignored(root)
    if announce:
        print(f"READY {memory}")


def init_memory(root: Path, announce: bool = True) -> None:
    with memory_lock(root):
        _init_memory(root, announce)


def compact_text(value: Any, field: str) -> str:
    if not isinstance(value, str):
        raise MemoryError(f"{field} must be a string")
    compact = " ".join(value.split())
    if not compact:
        raise MemoryError(f"{field} must not be empty")
    return compact


def string_list(value: Any, field: str, required: bool = False) -> list[str]:
    if value is None:
        value = []
    if not isinstance(value, list) or any(not isinstance(item, str) for item in value):
        raise MemoryError(f"{field} must be an array of strings")
    result = list(dict.fromkeys(" ".join(item.split()) for item in value if item.split()))
    if required and not result:
        raise MemoryError(f"{field} must not be empty")
    return result


def reference_list(value: Any) -> list[dict[str, str]]:
    if value is None:
        return []
    if not isinstance(value, list):
        raise MemoryError("references must be an array of objects")
    fields = ("kind", "id", "path", "session", "label")
    references: list[dict[str, str]] = []
    seen: set[str] = set()
    for item in value:
        if not isinstance(item, dict) or set(item) - set(fields):
            raise MemoryError("reference fields must be kind, id, path, session, or label")
        reference: dict[str, str] = {}
        for field in fields:
            if field in item:
                text = item[field]
                if not isinstance(text, str) or not text.strip() or "\0" in text:
                    raise MemoryError(f"reference {field} must be a non-empty string without NUL")
                # Preserve exact locators, including whitespace in filesystem paths.
                reference[field] = text
        if "kind" not in reference or not ("id" in reference or "path" in reference):
            raise MemoryError("reference requires kind and at least one of id or path")
        key = json.dumps(reference, sort_keys=True, ensure_ascii=False)
        if key not in seen:
            seen.add(key)
            references.append(reference)
    return references


def preserve_references(target: dict[str, Any], *records: dict[str, Any]) -> None:
    references = reference_list([ref for record in records for ref in record.get("refs", [])])
    if references:
        target["refs"] = references


def source_path(root: Path, value: str) -> tuple[str, Path]:
    candidate = (root / value).resolve()
    try:
        relative = candidate.relative_to(root)
    except ValueError as exc:
        raise MemoryError(f"source path escapes repository: {value}") from exc
    if not candidate.is_file():
        raise MemoryError(f"source path is not a file: {relative.as_posix()}")
    relative_text = relative.as_posix()
    if relative_text == MEMORY_DIR or relative_text.startswith(f"{MEMORY_DIR}/"):
        raise MemoryError(f"memory cannot fingerprint itself: {relative_text}")
    return relative_text, candidate


def fingerprint(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as source:
        for chunk in iter(lambda: source.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def confined_draft_path(root: Path, value: str) -> Path:
    drafts = (root / MEMORY_DIR / "drafts").resolve()
    candidate = Path(value).expanduser().resolve()
    try:
        candidate.relative_to(drafts)
    except ValueError as exc:
        raise MemoryError(f"draft must be inside {drafts}: {candidate}") from exc
    if not candidate.is_file():
        raise MemoryError(f"draft is not a file: {candidate}")
    return candidate


def normalize_draft(root: Path, draft: dict[str, Any]) -> dict[str, Any]:
    identifier = compact_text(draft.get("id"), "id")
    if not ID_PATTERN.fullmatch(identifier):
        raise MemoryError("id must match [a-z0-9][a-z0-9._-]{0,79}")

    raw_paths = string_list(draft.get("paths"), "paths", required=True)
    paths: list[str] = []
    fingerprints: dict[str, str] = {}
    for raw_path in raw_paths:
        relative, absolute = source_path(root, raw_path)
        if relative not in fingerprints:
            paths.append(relative)
            fingerprints[relative] = fingerprint(absolute)

    record = {
        "v": 1,
        "id": identifier,
        "k": string_list(draft.get("keywords"), "keywords", required=True),
        "p": paths,
        "s": string_list(draft.get("symbols"), "symbols"),
        "sum": compact_text(draft.get("summary"), "summary"),
        "f": string_list(draft.get("facts"), "facts", required=True),
        "flow": string_list(draft.get("flows"), "flows"),
        "inv": string_list(draft.get("invariants"), "invariants"),
        "fx": string_list(draft.get("side_effects"), "side_effects"),
        "verify": string_list(draft.get("verification"), "verification", required=True),
        "fp": fingerprints,
    }
    references = reference_list(draft.get("references"))
    if references:
        record["refs"] = references
    return record


def load_record(path: Path) -> dict[str, Any]:
    try:
        record = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, UnicodeError, json.JSONDecodeError) as exc:
        raise MemoryError(f"cannot read {path}: {exc}") from exc
    if not isinstance(record, dict) or record.get("v") != 1:
        raise MemoryError(f"unsupported record format: {path}")
    list_fields = ("k", "p", "s", "f", "flow", "inv", "fx", "verify")
    for field in ("id", *list_fields, "sum", "fp"):
        if field not in record:
            raise MemoryError(f"record {path} is missing {field}")
    if not isinstance(record["id"], str) or not ID_PATTERN.fullmatch(record["id"]):
        raise MemoryError(f"record {path} has an invalid id")
    for field in list_fields:
        value = record[field]
        if not isinstance(value, list) or any(not isinstance(item, str) for item in value):
            raise MemoryError(f"record {path} has an invalid {field} list")
    if not record["k"] or not record["p"] or not record["f"] or not record["verify"]:
        raise MemoryError(f"record {path} is missing required knowledge")
    if not isinstance(record["sum"], str) or not record["sum"].strip():
        raise MemoryError(f"record {path} has an invalid summary")
    if any(
        Path(relative).is_absolute()
        or ".." in Path(relative).parts
        or relative == MEMORY_DIR
        or relative.startswith(f"{MEMORY_DIR}/")
        for relative in record["p"]
    ):
        raise MemoryError(f"record {path} has an unsafe source path")
    fingerprints = record["fp"]
    if (
        not isinstance(fingerprints, dict)
        or set(fingerprints) != set(record["p"])
        or any(not isinstance(key, str) or not isinstance(value, str) for key, value in fingerprints.items())
    ):
        raise MemoryError(f"record {path} has invalid fingerprints")
    if "refs" in record:
        record["refs"] = reference_list(record["refs"])
    return record


def record_files(records: Path) -> Iterable[Path]:
    return sorted(records.glob("*.json")) if records.is_dir() else []


def folded_set(values: Iterable[str]) -> set[str]:
    return {value.casefold() for value in values}


def structural_similarity(left: set[str], right: set[str]) -> float:
    if not left or not right:
        return 0.0
    if min(len(left), len(right)) / max(len(left), len(right)) < MIN_STRUCTURE_SIZE_RATIO:
        return 0.0
    return len(left & right) / min(len(left), len(right))


def jaccard_similarity(left: set[str], right: set[str]) -> float:
    if not left and not right:
        return 1.0
    if not left or not right:
        return 0.0
    return len(left & right) / len(left | right)


def summary_tokens(value: str) -> set[str]:
    return {token.casefold() for token in WORD_PATTERN.findall(value) if len(token) > 1}


def topic_similarity(left: dict[str, Any], right: dict[str, Any]) -> float:
    left_paths = set(left["p"])
    right_paths = set(right["p"])
    left_symbols = set(left["s"])
    right_symbols = set(right["s"])
    keyword_similarity = jaccard_similarity(folded_set(left["k"]), folded_set(right["k"]))
    summary_similarity = jaccard_similarity(summary_tokens(left["sum"]), summary_tokens(right["sum"]))
    path_similarity = structural_similarity(left_paths, right_paths)

    if not left_symbols or not right_symbols:
        if (
            path_similarity < 1.0
            or keyword_similarity < 0.80
            or summary_similarity < 0.80
        ):
            return 0.0
        symbol_similarity = 1.0
    else:
        symbol_similarity = structural_similarity(left_symbols, right_symbols)
        if (
            (path_similarity < 1.0 and symbol_similarity < 1.0)
            or keyword_similarity < MIN_CONTENT_SIMILARITY
            or summary_similarity < MIN_CONTENT_SIMILARITY
        ):
            return 0.0

    return (
        0.40 * path_similarity
        + 0.35 * symbol_similarity
        + 0.15 * keyword_similarity
        + 0.10 * summary_similarity
    )


def merge_record(existing: dict[str, Any], incoming: dict[str, Any]) -> dict[str, Any]:
    merged = dict(existing)
    for field in ("k", "p", "s", "f", "flow", "inv", "fx", "verify"):
        if field == "k":
            seen = folded_set(existing[field])
            merged[field] = [*existing[field]]
            for item in incoming[field]:
                if item.casefold() not in seen:
                    seen.add(item.casefold())
                    merged[field].append(item)
        else:
            merged[field] = list(dict.fromkeys([*existing[field], *incoming[field]]))
    merged["fp"] = {
        path: incoming["fp"].get(path, existing["fp"].get(path))
        for path in merged["p"]
    }
    preserve_references(merged, existing, incoming)
    return merged


def adds_knowledge(existing: dict[str, Any], incoming: dict[str, Any]) -> bool:
    if not folded_set(incoming["k"]).issubset(folded_set(existing["k"])):
        return True
    return any(
        not set(incoming[field]).issubset(existing[field])
        for field in ("p", "s", "f", "flow", "inv", "fx", "verify")
    )


def has_fact_continuity(existing: dict[str, Any], incoming: dict[str, Any]) -> bool:
    return bool(folded_set(existing["f"]) & folded_set(incoming["f"]))


def find_similar_record(
    root: Path, records: Path, incoming: dict[str, Any]
) -> tuple[dict[str, Any] | None, float]:
    candidates: list[tuple[float, str, dict[str, Any]]] = []
    for path in record_files(records):
        try:
            record = load_record(path)
        except MemoryError as exc:
            print(f"ERROR {path.stem} {exc}")
            prune_record(records, path, path.stem)
            continue
        if path.name != f"{record['id']}.json":
            print(f"ERROR record filename does not match id: {path}")
            prune_record(records, path, path.stem)
            continue
        if record["id"] == incoming["id"]:
            continue
        similarity = topic_similarity(record, incoming)
        if similarity < SIMILARITY_THRESHOLD:
            continue
        valid, changed = freshness(root, record)
        if not valid:
            print(f"STALE {record['id']} {' '.join(changed)}")
            prune_record(records, path, record["id"])
            continue
        if not has_fact_continuity(record, incoming):
            continue
        candidates.append((similarity, record["id"], record))
    if not candidates:
        return None, 0.0
    similarity, _, record = min(candidates, key=lambda item: (-item[0], item[1]))
    return record, similarity


def clean_index_field(value: str) -> str:
    return " ".join(value.replace("\t", " ").split())


def _rebuild_index(root: Path) -> int:
    _, index, records = memory_paths(root)
    rows: list[str] = []
    errors = 0
    seen: set[str] = set()
    for path in record_files(records):
        try:
            record = load_record(path)
            identifier = record["id"]
            if identifier in seen:
                raise MemoryError(f"duplicate record id: {identifier}")
            if path.name != f"{identifier}.json":
                raise MemoryError(f"record filename does not match id: {path}")
            seen.add(identifier)
            fields = [
                identifier,
                ",".join(record["k"]),
                ",".join(record["p"]),
                ",".join(record["s"]),
                record["sum"],
            ]
            rows.append("\t".join(clean_index_field(str(field)) for field in fields))
        except MemoryError as exc:
            errors += 1
            print(f"ERROR {exc}", file=sys.stderr)
    atomic_write(index, INDEX_HEADER + "\n".join(rows) + ("\n" if rows else ""))
    print(f"INDEXED {len(rows)} errors={errors}")
    return 1 if errors else 0


def rebuild_index(root: Path) -> int:
    with memory_lock(root):
        return _rebuild_index(root)


def _save_record(root: Path, draft_path: str) -> int:
    _init_memory(root)
    draft_file = confined_draft_path(root, draft_path)
    try:
        draft = json.loads(draft_file.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as exc:
        raise MemoryError(f"cannot read draft {draft_path}: {exc}") from exc
    if not isinstance(draft, dict):
        raise MemoryError("draft must contain a JSON object")
    record = normalize_draft(root, draft)
    _, _, records = memory_paths(root)
    destination = records / f"{record['id']}.json"
    replace_same_id = destination.exists()
    if replace_same_id:
        try:
            previous = load_record(destination)
        except MemoryError:
            previous = None  # Existing malformed records can still be replaced.
        if previous is not None and previous["id"] == record["id"]:
            preserve_references(record, previous, record)
    existing, similarity = find_similar_record(root, records, record)
    if replace_same_id:
        existing = None

    if existing is None:
        atomic_write(destination, json.dumps(record, ensure_ascii=False, separators=(",", ":")) + "\n")
        print(f"SAVED {record['id']}")
    elif adds_knowledge(existing, record):
        merged = merge_record(existing, record)
        destination = records / f"{existing['id']}.json"
        atomic_write(destination, json.dumps(merged, ensure_ascii=False, separators=(",", ":")) + "\n")
        print(f"MERGED {record['id']} into={existing['id']} similarity={similarity:.2f}")
    else:
        referenced = dict(existing)
        preserve_references(referenced, existing, record)
        if referenced.get("refs") != existing.get("refs"):
            destination = records / f"{existing['id']}.json"
            atomic_write(destination, json.dumps(referenced, ensure_ascii=False, separators=(",", ":")) + "\n")
            print(f"REFERENCED {record['id']} into={existing['id']} similarity={similarity:.2f}")
        else:
            print(f"UNCHANGED {record['id']} duplicate-of={existing['id']} similarity={similarity:.2f}")
    result = _rebuild_index(root)
    if result == 0:
        draft_file.unlink()
    return result


def save_record(root: Path, draft_path: str) -> int:
    with memory_lock(root):
        return _save_record(root, draft_path)


def freshness(root: Path, record: dict[str, Any]) -> tuple[bool, list[str]]:
    changed: list[str] = []
    for relative in record["p"]:
        candidate = root / relative
        try:
            resolved = candidate.resolve(strict=True)
        except FileNotFoundError:
            changed.append(f"{relative}:missing")
            continue
        except OSError:
            changed.append(f"{relative}:unreadable")
            continue
        try:
            resolved_relative = resolved.relative_to(root).as_posix()
        except ValueError:
            changed.append(f"{relative}:unsafe")
            continue
        if resolved_relative != relative:
            changed.append(f"{relative}:redirected")
            continue
        if not resolved.is_file():
            changed.append(f"{relative}:missing")
            continue
        try:
            current_fingerprint = fingerprint(resolved)
        except OSError:
            changed.append(f"{relative}:unreadable")
            continue
        if current_fingerprint != record["fp"].get(relative):
            changed.append(f"{relative}:changed")
    return not changed, changed


def prune_record(records: Path, path: Path, identifier: str) -> None:
    if path.parent != records or path.name != f"{identifier}.json":
        raise MemoryError(f"refusing to prune unsafe record path: {path}")
    try:
        path.unlink(missing_ok=True)
    except OSError as exc:
        raise MemoryError(f"cannot prune record {path}: {exc}") from exc
    print(f"PRUNED {identifier}")


def read_index(index: Path) -> tuple[list[dict[str, str]], bool]:
    if not index.is_file():
        return [], False
    try:
        lines = index.read_text(encoding="utf-8").splitlines()
    except (OSError, UnicodeError) as exc:
        print(f"ERROR cannot read index {index}: {exc}", file=sys.stderr)
        return [], True

    rows: list[dict[str, str]] = []
    malformed = lines[:2] != INDEX_HEADER.splitlines()
    if malformed:
        print("ERROR malformed index header", file=sys.stderr)
    seen: set[str] = set()
    for number, line in enumerate(lines, start=1):
        if not line or line.startswith("#"):
            continue
        fields = line.split("\t")
        if len(fields) != 5:
            print(f"ERROR malformed index row {number}", file=sys.stderr)
            malformed = True
            continue
        identifier = fields[0]
        if not ID_PATTERN.fullmatch(identifier):
            print(f"ERROR invalid index id on row {number}", file=sys.stderr)
            malformed = True
            continue
        if identifier in seen:
            print(f"ERROR duplicate index id on row {number}", file=sys.stderr)
            malformed = True
            continue
        seen.add(identifier)
        rows.append(dict(zip(("id", "keywords", "paths", "symbols", "summary"), fields)))
    return rows, malformed


def locate_symbols(root: Path, record: dict[str, Any]) -> dict[str, Any]:
    selected_symbols = record["s"][:MAX_SYMBOLS_TO_LOCATE]
    matches: dict[str, list[dict[str, Any]]] = {symbol: [] for symbol in selected_symbols}
    truncated: set[str] = set()
    errors: list[str] = []
    error_count = 0
    for relative in record["p"]:
        candidate = root / relative
        try:
            resolved = candidate.resolve(strict=True)
            if resolved.relative_to(root).as_posix() != relative:
                raise ValueError("source path was redirected")
            with resolved.open("r", encoding="utf-8") as source:
                for line_number, line in enumerate(source, start=1):
                    for symbol in selected_symbols:
                        if symbol not in line:
                            continue
                        locations = matches[symbol]
                        if len(locations) < MAX_LOCATIONS_PER_SYMBOL:
                            locations.append({"path": relative, "line": line_number})
                        else:
                            truncated.add(symbol)
        except (OSError, UnicodeError, ValueError) as exc:
            error_count += 1
            if len(errors) < MAX_LOCATION_ERRORS:
                errors.append(f"{relative}: {exc}")
    omitted_symbols = len(record["s"]) - len(selected_symbols)
    return {
        "symbols": [
            {
                "symbol": symbol,
                "matches": matches[symbol],
                **({"truncated": True} if symbol in truncated else {}),
            }
            for symbol in selected_symbols
        ],
        **({"symbols_truncated": omitted_symbols} if omitted_symbols else {}),
        **({"errors": errors} if errors else {}),
        **({"errors_truncated": error_count - len(errors)} if error_count > len(errors) else {}),
    }


def query_payload(record: dict[str, Any], locations: dict[str, Any] | None = None) -> dict[str, Any]:
    payload = {
        "id": record["id"],
        "p": record["p"],
        "s": record["s"],
        "sum": record["sum"],
        "f": record["f"],
        "flow": record["flow"],
        "inv": record["inv"],
        "fx": record["fx"],
        "verify": record["verify"],
    }
    if record.get("refs"):
        payload["refs"] = record["refs"]
    if locations is not None:
        payload["loc"] = locations
    return payload


def _query_memory(root: Path, query: str, limit: int, locate: bool = False) -> int:
    _init_memory(root, announce=False)
    _, index, records = memory_paths(root)
    if not index.is_file():
        print("NO_INDEX")
        return 0
    rows, repair_index = read_index(index)
    if not rows:
        print("EMPTY_INDEX")
        return _rebuild_index(root) if repair_index else 0

    terms = {term.casefold() for term in TOKEN_PATTERN.findall(query) if len(term) > 1}
    ranked: list[tuple[int, dict[str, str]]] = []
    for row in rows:
        haystack = " ".join(row.values()).casefold()
        score = sum(3 if term in row["symbols"].casefold() else 1 for term in terms if term in haystack)
        if score:
            ranked.append((score, row))
    ranked.sort(key=lambda item: (-item[0], item[1]["id"]))
    if not ranked:
        print("NO_MATCH")
        return _rebuild_index(root) if repair_index else 0

    valid_count = 0
    for score, row in ranked:
        if valid_count >= limit:
            break
        path = records / f"{row['id']}.json"
        should_prune = False
        try:
            record = load_record(path)
            if record["id"] != row["id"]:
                raise MemoryError(f"index id does not match record id: {path}")
            valid, changed = freshness(root, record)
            locations = locate_symbols(root, record) if valid and locate else None
            if valid and locate:
                valid, changed = freshness(root, record)
            if valid:
                print(f"VALID {row['id']} score={score}")
                print(json.dumps(query_payload(record, locations), ensure_ascii=False, separators=(",", ":")))
                valid_count += 1
            else:
                print(f"STALE {row['id']} {' '.join(changed)}")
                should_prune = True
        except MemoryError as exc:
            print(f"ERROR {row['id']} {exc}")
            should_prune = True
        if should_prune:
            prune_record(records, path, row["id"])
            repair_index = True
    return _rebuild_index(root) if repair_index else 0


def query_memory(root: Path, query: str, limit: int, locate: bool = False) -> int:
    with memory_lock(root):
        return _query_memory(root, query, limit, locate)


def _audit_memory(root: Path) -> int:
    _, _, records = memory_paths(root)
    if not records.is_dir():
        print("NO_MEMORY")
        return 0
    invalid = 0
    pruned = 0
    errors = 0
    total = 0
    for path in record_files(records):
        total += 1
        should_prune = False
        try:
            record = load_record(path)
            if path.name != f"{record['id']}.json":
                raise MemoryError(f"record filename does not match id: {path}")
            valid, changed = freshness(root, record)
            if valid:
                print(f"VALID {record['id']}")
            else:
                invalid += 1
                print(f"STALE {record['id']} {' '.join(changed)}")
                should_prune = True
        except MemoryError as exc:
            invalid += 1
            print(f"ERROR {exc}")
            should_prune = True
        if should_prune:
            try:
                prune_record(records, path, path.stem)
                pruned += 1
            except MemoryError as exc:
                errors += 1
                print(f"ERROR {exc}")
    rebuild_result = _rebuild_index(root)
    print(f"AUDITED {total} invalid={invalid} pruned={pruned}")
    return 1 if errors or rebuild_result else 0


def audit_memory(root: Path) -> int:
    memory, _, _ = memory_paths(root)
    if not memory.is_dir():
        print("NO_MEMORY")
        return 0
    with memory_lock(root):
        return _audit_memory(root)


def reindex_memory(root: Path) -> int:
    with memory_lock(root):
        _init_memory(root)
        return _rebuild_index(root)


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description=__doc__)
    subparsers = parser.add_subparsers(dest="command", required=True)
    for name in ("init", "reindex", "audit"):
        command = subparsers.add_parser(name)
        command.add_argument("--root", default=".")
    save = subparsers.add_parser("save")
    save.add_argument("--root", default=".")
    save.add_argument("draft")
    query = subparsers.add_parser("query")
    query.add_argument("--root", default=".")
    query.add_argument("--limit", type=int, default=3)
    query.add_argument(
        "--locate",
        action="store_true",
        help="resolve saved symbols to current path:line locations after fingerprint validation",
    )
    query.add_argument("query")
    return parser


def main() -> int:
    args = build_parser().parse_args()
    try:
        root = resolve_root(args.root)
        if args.command == "init":
            init_memory(root)
            return 0
        if args.command == "save":
            return save_record(root, args.draft)
        if args.command == "query":
            if args.limit < 1:
                raise MemoryError("limit must be at least 1")
            return query_memory(root, args.query, args.limit, args.locate)
        if args.command == "reindex":
            return reindex_memory(root)
        if args.command == "audit":
            return audit_memory(root)
        raise MemoryError(f"unsupported command: {args.command}")
    except MemoryError as exc:
        print(f"ERROR {exc}", file=sys.stderr)
        return 2


if __name__ == "__main__":
    raise SystemExit(main())
