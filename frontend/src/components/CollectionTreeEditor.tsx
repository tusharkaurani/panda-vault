import { FormEvent, useState } from "react";
import {
  ChevronDown,
  ChevronRight,
  FolderPlus,
  Pencil,
  Trash2,
  Link2,
  Link2Off,
} from "lucide-react";
import Tooltip from "./Tooltip";
import type { Collection, Source, SourceType } from "../types";
import { api, ApiError } from "../api";

const ICON_OPTIONS = ["folder", "newspaper", "book", "film", "music", "archive", "channel"];

const SOURCE_NOUN: Record<SourceType, string> = {
  telegram: "channel",
  m3u: "playlist",
};

/** Candidate parents for a move: containers only (a source-bound leaf can't
 *  hold children), and only within the same integration — the server rejects
 *  a cross-sourceType move, so offering one would just produce an error. */
function flatten(
  nodes: Collection[],
  excludeId: string | undefined,
  sourceType: SourceType,
  trail = ""
): { id: string; label: string }[] {
  let out: { id: string; label: string }[] = [];
  for (const n of nodes) {
    if (n.id === excludeId) continue; // skip the subtree being moved/edited entirely below
    if (n.sourceType !== sourceType) continue;
    const label = trail ? `${trail} / ${n.name}` : n.name;
    if (!n.sourceIds.length) out.push({ id: n.id, label });
    out = out.concat(flatten(n.children, excludeId, sourceType, label));
  }
  return out;
}

function SourceCheckboxList({
  sources,
  selected,
  onChange,
  disabled,
}: {
  sources: Source[];
  selected: string[];
  onChange: (ids: string[]) => void;
  disabled?: boolean;
}) {
  function toggle(id: string) {
    onChange(selected.includes(id) ? selected.filter((x) => x !== id) : [...selected, id]);
  }
  return (
    <div className="flex flex-col gap-1 max-h-40 overflow-y-auto rounded-md border border-panda-border bg-panda-surface p-2">
      {sources.length === 0 && <p className="text-xs text-panda-muted">Nothing to bind to yet.</p>}
      {sources.map((c) => (
        <label key={c.id} className={`flex items-center gap-2 text-xs px-1 py-0.5 rounded ${disabled ? "opacity-50" : "hover:bg-panda-surface2"}`}>
          <input
            type="checkbox"
            checked={selected.includes(c.id)}
            onChange={() => toggle(c.id)}
            disabled={disabled}
          />
          {c.name}
        </label>
      ))}
    </div>
  );
}

interface Props {
  nodes: Collection[];
  allNodes: Collection[];
  sources: Source[];
  onChange: () => void;
  depth?: number;
}

export default function CollectionTreeEditor({ nodes, allNodes, sources, onChange, depth = 0 }: Props) {
  return (
    <div className="flex flex-col gap-1.5">
      {nodes.map((n) => (
        <CollectionNode key={n.id} node={n} allNodes={allNodes} sources={sources} onChange={onChange} depth={depth} />
      ))}
    </div>
  );
}

function CollectionNode({
  node,
  allNodes,
  sources,
  onChange,
  depth,
}: {
  node: Collection;
  allNodes: Collection[];
  sources: Source[];
  onChange: () => void;
  depth: number;
}) {
  const [expanded, setExpanded] = useState(true);
  const [editing, setEditing] = useState(false);
  const [addingChild, setAddingChild] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const boundSources = sources.filter((c) => node.sourceIds.includes(c.id));
  const moveTargets = flatten(allNodes, node.id, node.sourceType);

  async function handleDelete() {
    if (!confirm(`Delete "${node.name}"? ${node.children.length ? "This also deletes its sub-collections." : ""}`)) return;
    setBusy(true);
    try {
      await api.collections.remove(node.id);
      onChange();
    } catch (e) {
      setError(e instanceof ApiError ? e.message : "Delete failed");
    } finally {
      setBusy(false);
    }
  }

  async function handleMove(parentId: string) {
    setBusy(true);
    setError(null);
    try {
      await api.collections.move(node.id, parentId === "__root__" ? null : parentId);
      onChange();
    } catch (e) {
      setError(e instanceof ApiError ? e.message : "Move failed");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div>
      <div
        className="flex items-center flex-wrap gap-2 rounded-lg border border-panda-border bg-panda-surface px-3 py-2"
        style={{ marginLeft: depth * 20 }}
      >
        <button
          onClick={() => setExpanded((v) => !v)}
          className="text-panda-muted hover:text-panda-text shrink-0"
          disabled={node.children.length === 0}
        >
          {node.children.length > 0 ? (expanded ? <ChevronDown size={16} /> : <ChevronRight size={16} />) : <span className="inline-block w-4" />}
        </button>

        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2 flex-wrap">
            <span className="font-medium truncate">{node.name}</span>
            {node.sourceIds.length > 0 ? (
              <span className="flex items-center gap-1 text-xs text-panda-accent2">
                <Link2 size={12} />
                {boundSources.length === node.sourceIds.length
                  ? boundSources.map((c) => c.name).join(", ")
                  : `${boundSources.length} of ${node.sourceIds.length} sources (some missing)`}
              </span>
            ) : (
              <span className="text-xs text-panda-muted">{node.children.length} sub-collection{node.children.length === 1 ? "" : "s"}</span>
            )}
          </div>
          {node.description && <p className="text-xs text-panda-muted truncate">{node.description}</p>}
        </div>

        <select
          value=""
          onChange={(e) => e.target.value && handleMove(e.target.value)}
          className="shrink-0 bg-panda-surface2 border border-panda-border rounded-md text-xs px-2 py-1 outline-none"
          title="Move to…"
          disabled={busy}
        >
          <option value="">Move…</option>
          <option value="__root__">Root</option>
          {moveTargets.map((t) => (
            <option key={t.id} value={t.id}>
              {t.label}
            </option>
          ))}
        </select>

        {!node.sourceIds.length && (
          <Tooltip label="Add sub-collection">
            <button
              onClick={() => setAddingChild((v) => !v)}
              className="p-1.5 rounded-md text-panda-muted hover:text-panda-accent hover:bg-panda-surface2"
            >
              <FolderPlus size={16} />
            </button>
          </Tooltip>
        )}
        <Tooltip label="Edit collection">
          <button onClick={() => setEditing((v) => !v)} className="p-1.5 rounded-md text-panda-muted hover:text-panda-accent hover:bg-panda-surface2">
            <Pencil size={16} />
          </button>
        </Tooltip>
        <Tooltip label="Delete collection">
          <button onClick={handleDelete} disabled={busy} className="p-1.5 rounded-md text-panda-muted hover:text-red-400 hover:bg-panda-surface2">
            <Trash2 size={16} />
          </button>
        </Tooltip>
      </div>

      {error && <p className="text-xs text-red-400 mt-1" style={{ marginLeft: depth * 20 }}>{error}</p>}

      {editing && (
        <div style={{ marginLeft: depth * 20 + 20 }}>
          <CollectionEditForm
            node={node}
            sources={sources}
            onDone={() => {
              setEditing(false);
              onChange();
            }}
            onCancel={() => setEditing(false)}
          />
        </div>
      )}

      {addingChild && (
        <div style={{ marginLeft: depth * 20 + 20 }}>
          <CollectionCreateForm
            parentId={node.id}
            sourceType={node.sourceType}
            sources={sources}
            onDone={() => {
              setAddingChild(false);
              onChange();
            }}
            onCancel={() => setAddingChild(false)}
          />
        </div>
      )}

      {expanded && node.children.length > 0 && (
        <div className="mt-1.5">
          <CollectionTreeEditor nodes={node.children} allNodes={allNodes} sources={sources} onChange={onChange} depth={depth + 1} />
        </div>
      )}
    </div>
  );
}

function CollectionEditForm({
  node,
  sources,
  onDone,
  onCancel,
}: {
  node: Collection;
  sources: Source[];
  onDone: () => void;
  onCancel: () => void;
}) {
  const [name, setName] = useState(node.name);
  const [description, setDescription] = useState(node.description);
  const [icon, setIcon] = useState(node.icon || "folder");
  const [sourceIds, setSourceIds] = useState<string[]>(node.sourceIds);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function submit(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await api.collections.update(node.id, { name, description, icon, sourceIds });
      onDone();
    } catch (e) {
      setError(e instanceof ApiError ? e.message : "Update failed");
    } finally {
      setBusy(false);
    }
  }

  return (
    <form onSubmit={submit} className="flex flex-col gap-2 rounded-lg border border-panda-border bg-panda-surface2 p-3 my-1.5 text-sm">
      {error && <p className="text-red-400 text-xs">{error}</p>}
      <div className="grid sm:grid-cols-2 gap-2">
        <input value={name} onChange={(e) => setName(e.target.value)} required placeholder="Name" className="bg-panda-surface border border-panda-border rounded-md px-2 py-1.5 outline-none focus:border-panda-accent" />
        <select value={icon} onChange={(e) => setIcon(e.target.value)} className="bg-panda-surface border border-panda-border rounded-md px-2 py-1.5 outline-none focus:border-panda-accent">
          {ICON_OPTIONS.map((i) => (
            <option key={i} value={i}>
              {i}
            </option>
          ))}
        </select>
      </div>
      <input value={description} onChange={(e) => setDescription(e.target.value)} placeholder="Description" className="bg-panda-surface border border-panda-border rounded-md px-2 py-1.5 outline-none focus:border-panda-accent" />
      <label className="flex items-center gap-2 text-xs text-panda-muted">
        {sourceIds.length > 0 ? <Link2 size={12} /> : <Link2Off size={12} />}
        <span>Bind to {SOURCE_NOUN[node.sourceType]}(s) (none selected = container collection):</span>
      </label>
      <SourceCheckboxList sources={sources} selected={sourceIds} onChange={setSourceIds} disabled={node.children.length > 0} />
      {node.children.length > 0 && <p className="text-xs text-panda-muted">Has sub-collections — can't bind channels until they're removed.</p>}
      <div className="flex justify-end gap-2 pt-1">
        <button type="button" onClick={onCancel} className="px-3 py-1 rounded-md border border-panda-border hover:border-panda-muted">
          Cancel
        </button>
        <button type="submit" disabled={busy} className="px-3 py-1 rounded-md bg-panda-accent text-panda-bg font-medium hover:opacity-90 disabled:opacity-50">
          Save
        </button>
      </div>
    </form>
  );
}

function CollectionCreateForm({
  parentId,
  sources,
  onDone,
  onCancel,
  sourceType = "telegram",
}: {
  parentId: string | null;
  sources: Source[];
  onDone: () => void;
  onCancel: () => void;
  /** Only consulted at the root — a sub-collection inherits its parent's
   *  type and the server rejects any attempt to say otherwise. */
  sourceType?: SourceType;
}) {
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [icon, setIcon] = useState("folder");
  const [sourceIds, setSourceIds] = useState<string[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function submit(e: FormEvent) {
    e.preventDefault();
    if (!name.trim()) return;
    setBusy(true);
    setError(null);
    try {
      await api.collections.create({
        name: name.trim(),
        description: description.trim(),
        icon,
        sourceIds,
        parentId,
        sourceType: parentId === null ? sourceType : undefined,
      });
      onDone();
    } catch (e) {
      setError(e instanceof ApiError ? e.message : "Create failed");
    } finally {
      setBusy(false);
    }
  }

  return (
    <form onSubmit={submit} className="flex flex-col gap-2 rounded-lg border border-dashed border-panda-accent/50 bg-panda-surface2 p-3 my-1.5 text-sm">
      {error && <p className="text-red-400 text-xs">{error}</p>}
      <div className="grid sm:grid-cols-2 gap-2">
        <input value={name} onChange={(e) => setName(e.target.value)} required autoFocus placeholder="New collection name" className="bg-panda-surface border border-panda-border rounded-md px-2 py-1.5 outline-none focus:border-panda-accent" />
        <select value={icon} onChange={(e) => setIcon(e.target.value)} className="bg-panda-surface border border-panda-border rounded-md px-2 py-1.5 outline-none focus:border-panda-accent">
          {ICON_OPTIONS.map((i) => (
            <option key={i} value={i}>
              {i}
            </option>
          ))}
        </select>
      </div>
      <label className="text-xs text-panda-muted">Bind to {SOURCE_NOUN[sourceType]}(s) (none selected = container collection):</label>
      <SourceCheckboxList sources={sources} selected={sourceIds} onChange={setSourceIds} />
      <div className="flex justify-end gap-2 pt-1">
        <button type="button" onClick={onCancel} className="px-3 py-1 rounded-md border border-panda-border hover:border-panda-muted">
          Cancel
        </button>
        <button type="submit" disabled={busy} className="px-3 py-1 rounded-md bg-panda-accent text-panda-bg font-medium hover:opacity-90 disabled:opacity-50">
          Create
        </button>
      </div>
    </form>
  );
}

export { CollectionCreateForm };
