"use client";

import {
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
} from "react";
import { AtSign, CornerDownLeft, Search } from "lucide-react";
import styles from "./ScriptRichTextEditor.module.css";

export type ScriptMentionTarget = {
  id: string;
  name: string;
  type: "asset" | "character";
  category?: string | null;
  mediaType?: string | null;
  description?: string | null;
};

type MentionToken =
  | { type: "text"; value: string }
  | { type: "mention"; target: ScriptMentionTarget };

type ScriptRichTextEditorProps = {
  value: string;
  targets: ScriptMentionTarget[];
  disabled?: boolean;
  onChange: (value: string) => void;
};

const CATEGORY_LABELS: Record<string, string> = {
  character: "人物",
  costume: "服装",
  prop: "道具",
  scene: "场景",
  environment: "环境",
  vehicle: "载具",
  storyboard: "分镜",
  final: "成片",
  reference: "参考",
  other: "其他",
};

const MEDIA_LABELS: Record<string, string> = {
  image: "图片",
  video: "视频",
  audio: "音频",
  model3d: "3D",
  document: "文档",
  other: "资产",
};

function targetTypeLabel(target: ScriptMentionTarget): string {
  if (target.type === "character") return "人物";
  const media = target.mediaType ? MEDIA_LABELS[target.mediaType] ?? target.mediaType : "资产";
  const category = target.category ? CATEGORY_LABELS[target.category] ?? target.category : "";
  return category && category !== media ? `${media} · ${category}` : media;
}

function normalizeTargets(targets: ScriptMentionTarget[]): ScriptMentionTarget[] {
  const seen = new Set<string>();
  return targets
    .filter((target) => Boolean(target.id && target.name.trim()))
    .filter((target) => {
      const key = `${target.type}:${target.id}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
}

export function serializeScriptMention(target: ScriptMentionTarget): string {
  const encodedName = target.name
    .replace(/%/g, "%25")
    .replace(/\]/g, "%5D")
    .replace(/\r/g, "%0D")
    .replace(/\n/g, "%0A");
  return `@[${encodedName}](${target.type}:${encodeURIComponent(target.id)})`;
}

function safeDecode(value: string, component = false): string {
  try {
    return component ? decodeURIComponent(value) : decodeURI(value);
  } catch {
    return value;
  }
}

function tokenizeNamedMentions(text: string, targets: ScriptMentionTarget[]): MentionToken[] {
  if (!text) return [];
  const namedTargets = targets
    .filter((target) => target.name.length > 0)
    .sort((left, right) => right.name.length - left.name.length);
  if (namedTargets.length === 0) return [{ type: "text", value: text }];

  const tokens: MentionToken[] = [];
  let cursor = 0;
  while (cursor < text.length) {
    const mentionStart = text.indexOf("@", cursor);
    if (mentionStart < 0) {
      tokens.push({ type: "text", value: text.slice(cursor) });
      break;
    }
    const target = namedTargets.find((candidate) => text.startsWith(`@${candidate.name}`, mentionStart));
    if (!target) {
      const nextCursor = mentionStart + 1;
      tokens.push({ type: "text", value: text.slice(cursor, nextCursor) });
      cursor = nextCursor;
      continue;
    }
    if (mentionStart > cursor) tokens.push({ type: "text", value: text.slice(cursor, mentionStart) });
    tokens.push({ type: "mention", target });
    cursor = mentionStart + target.name.length + 1;
  }
  return tokens;
}

export function tokenizeScriptMentions(
  text: string,
  targets: ScriptMentionTarget[],
): MentionToken[] {
  if (!text) return [];
  const normalizedTargets = normalizeTargets(targets);
  const tokens: MentionToken[] = [];
  const stableMention = /@\[([^\]]*)\]\((asset|character):([^\)]+)\)/gu;
  let cursor = 0;
  for (const match of text.matchAll(stableMention)) {
    const index = match.index ?? 0;
    tokens.push(...tokenizeNamedMentions(text.slice(cursor, index), normalizedTargets));
    const type = match[2] as ScriptMentionTarget["type"];
    const id = safeDecode(match[3], true);
    const resolved = normalizedTargets.find((target) => target.type === type && target.id === id);
    tokens.push({
      type: "mention",
      target: resolved ?? {
        id,
        name: safeDecode(match[1], true) || "已移除资产",
        type,
        description: "原引用已不在当前项目中",
      },
    });
    cursor = index + match[0].length;
  }
  tokens.push(...tokenizeNamedMentions(text.slice(cursor), normalizedTargets));
  return tokens;
}

function appendTextWithBreaks(parent: HTMLElement, value: string): void {
  const parts = value.split("\n");
  parts.forEach((part, index) => {
    if (part) parent.append(parent.ownerDocument.createTextNode(part));
    if (index < parts.length - 1) parent.append(parent.ownerDocument.createElement("br"));
  });
}

function createMentionElement(target: ScriptMentionTarget, ownerDocument: Document): HTMLSpanElement {
  const element = ownerDocument.createElement("span");
  element.className = styles.mention;
  element.contentEditable = "false";
  element.dataset.mentionId = target.id;
  element.dataset.mentionType = target.type;
  element.dataset.mentionName = target.name;
  element.setAttribute("aria-label", `引用${targetTypeLabel(target)}：${target.name}`);
  element.title = `引用${targetTypeLabel(target)}：${target.name}`;
  element.textContent = `@${target.name}`;
  return element;
}

function hydrateEditor(
  editor: HTMLDivElement,
  value: string,
  targets: ScriptMentionTarget[],
): void {
  editor.replaceChildren();
  for (const token of tokenizeScriptMentions(value, targets)) {
    if (token.type === "mention") editor.append(createMentionElement(token.target, editor.ownerDocument));
    else appendTextWithBreaks(editor, token.value);
  }
}

function serializeEditorText(editor: HTMLElement): string {
  const blockTags = new Set(["DIV", "P", "LI"]);
  const readNode = (node: Node): string => {
    if (node.nodeType === node.TEXT_NODE) return node.nodeValue ?? "";
    if (!(node instanceof HTMLElement)) return "";
    if (node.tagName === "BR") return "\n";
    if (node.dataset.mentionId && (node.dataset.mentionType === "asset" || node.dataset.mentionType === "character")) {
      return serializeScriptMention({
        id: node.dataset.mentionId,
        name: node.dataset.mentionName || node.textContent?.replace(/^@/, "") || "已移除资产",
        type: node.dataset.mentionType,
      });
    }
    const content = Array.from(node.childNodes, readNode).join("");
    return blockTags.has(node.tagName) ? `${content}\n` : content;
  };
  const text = Array.from(editor.childNodes, readNode).join("");
  return text.endsWith("\n") && editor.lastElementChild && blockTags.has(editor.lastElementChild.tagName)
    ? text.slice(0, -1)
    : text;
}

function readEditorText(editor: HTMLDivElement): string {
  return serializeEditorText(editor)
    .replace(/\u200B/g, "")
    .replace(/\u00A0/g, " ")
    .replace(/\r\n?/g, "\n");
}

function rangeFromTextOffsets(
  root: HTMLElement,
  startOffset: number,
  endOffset: number,
): Range | null {
  const view = root.ownerDocument.defaultView;
  const walker = root.ownerDocument.createTreeWalker(root, view?.NodeFilter.SHOW_TEXT ?? 4);
  const textNodes: Text[] = [];
  let current = walker.nextNode();
  while (current) {
    textNodes.push(current as Text);
    current = walker.nextNode();
  }
  const pointAtOffset = (requestedOffset: number, preferNextAtBoundary: boolean) => {
    let textOffset = 0;
    for (let index = 0; index < textNodes.length; index += 1) {
      const textNode = textNodes[index];
      const nextOffset = textOffset + textNode.data.length;
      if (requestedOffset < nextOffset) return { node: textNode, offset: requestedOffset - textOffset };
      if (requestedOffset === nextOffset) {
        if (preferNextAtBoundary && index < textNodes.length - 1) {
          textOffset = nextOffset;
          continue;
        }
        return { node: textNode, offset: textNode.data.length };
      }
      textOffset = nextOffset;
    }
    return null;
  };
  const startPoint = pointAtOffset(startOffset, true);
  const endPoint = pointAtOffset(endOffset, false);
  if (!startPoint || !endPoint) return null;
  const range = root.ownerDocument.createRange();
  range.setStart(startPoint.node, startPoint.offset);
  range.setEnd(endPoint.node, endPoint.offset);
  return range;
}

function mentionElementForNode(node: Node, editor: HTMLElement): HTMLElement | null {
  const element = node.nodeType === 1 ? node as HTMLElement : node.parentElement;
  const mention = element?.closest<HTMLElement>("[data-mention-id]") ?? null;
  return mention && editor.contains(mention) ? mention : null;
}

function selectionIsInside(editor: HTMLDivElement, selection: Selection | null): selection is Selection {
  if (!selection || selection.rangeCount === 0) return false;
  const node = selection.getRangeAt(0).commonAncestorContainer;
  return node === editor || editor.contains(node);
}

export function ScriptBodyText({
  text,
  targets,
}: {
  text: string;
  targets: ScriptMentionTarget[];
}) {
  return (
    <span className={styles.renderedText}>
      {tokenizeScriptMentions(text, targets).map((token, index) => token.type === "mention" ? (
        <span
          className={`${styles.mention} ${styles.renderedMention}`}
          data-mention-id={token.target.id}
          data-mention-type={token.target.type}
          title={`引用${targetTypeLabel(token.target)}：${token.target.name}`}
          key={`${token.target.type}-${token.target.id}-${index}`}
        >
          @{token.target.name}
        </span>
      ) : <span key={`text-${index}`}>{token.value}</span>)}
    </span>
  );
}

export default function ScriptRichTextEditor({
  value,
  targets,
  disabled = false,
  onChange,
}: ScriptRichTextEditorProps) {
  const editorRef = useRef<HTMLDivElement>(null);
  const wrapperRef = useRef<HTMLDivElement>(null);
  const lastEmittedValueRef = useRef<string | null>(null);
  const lastSelectionRef = useRef<Range | null>(null);
  const mentionRangeRef = useRef<Range | null>(null);
  const composingRef = useRef(false);
  const hydratedRef = useRef(false);
  const listboxId = useId();
  const normalizedTargets = useMemo(() => normalizeTargets(targets), [targets]);
  const [mentionQuery, setMentionQuery] = useState<string | null>(null);
  const [activeIndex, setActiveIndex] = useState(0);

  const candidates = useMemo(() => {
    if (mentionQuery === null) return [];
    const needle = mentionQuery.trim().toLocaleLowerCase("zh-CN");
    return normalizedTargets
      .filter((target) => !needle
        || target.name.toLocaleLowerCase("zh-CN").includes(needle)
        || String(target.description ?? "").toLocaleLowerCase("zh-CN").includes(needle))
      .slice(0, 8);
  }, [mentionQuery, normalizedTargets]);

  useEffect(() => {
    const editor = editorRef.current;
    if (!editor) return;
    if (hydratedRef.current && value === lastEmittedValueRef.current) return;
    hydrateEditor(editor, value, normalizedTargets);
    hydratedRef.current = true;
    lastEmittedValueRef.current = value;
  }, [normalizedTargets, value]);

  function emitChange(): void {
    const editor = editorRef.current;
    if (!editor) return;
    const nextValue = readEditorText(editor);
    lastEmittedValueRef.current = nextValue;
    onChange(nextValue);
  }

  function rememberSelection(): void {
    const editor = editorRef.current;
    const selection = editor?.ownerDocument.defaultView?.getSelection() ?? null;
    if (!editor || !selectionIsInside(editor, selection)) return;
    lastSelectionRef.current = selection.getRangeAt(0).cloneRange();
  }

  function closeMentionMenu(): void {
    mentionRangeRef.current = null;
    setMentionQuery(null);
    setActiveIndex(0);
  }

  function updateMentionFromSelection(): void {
    const editor = editorRef.current;
    const selection = editor?.ownerDocument.defaultView?.getSelection() ?? null;
    if (!editor || !selectionIsInside(editor, selection) || !selection.isCollapsed) {
      closeMentionMenu();
      return;
    }
    const caretRange = selection.getRangeAt(0).cloneRange();
    lastSelectionRef.current = caretRange.cloneRange();
    const beforeCaret = caretRange.cloneRange();
    beforeCaret.selectNodeContents(editor);
    beforeCaret.setEnd(caretRange.endContainer, caretRange.endOffset);
    const beforeText = beforeCaret.toString();
    const match = beforeText.match(/@([^@\s\u200B]{0,60})$/u);
    if (!match) {
      closeMentionMenu();
      return;
    }
    const endOffset = beforeText.length;
    const startOffset = endOffset - match[0].length;
    const mentionRange = rangeFromTextOffsets(editor, startOffset, endOffset);
    if (!mentionRange || mentionElementForNode(mentionRange.startContainer, editor)) {
      closeMentionMenu();
      return;
    }
    mentionRangeRef.current = mentionRange;
    setMentionQuery(match[1]);
    setActiveIndex(0);
  }

  function setCaret(range: Range): void {
    const selection = editorRef.current?.ownerDocument.defaultView?.getSelection();
    if (!selection) return;
    selection.removeAllRanges();
    selection.addRange(range);
    lastSelectionRef.current = range.cloneRange();
  }

  function insertMention(target: ScriptMentionTarget): void {
    const editor = editorRef.current;
    const range = mentionRangeRef.current;
    if (!editor || !range || disabled) return;
    range.deleteContents();
    const mention = createMentionElement(target, editor.ownerDocument);
    const caretAnchor = editor.ownerDocument.createTextNode("\u200B");
    const fragment = editor.ownerDocument.createDocumentFragment();
    fragment.append(mention, caretAnchor);
    range.insertNode(fragment);
    const caret = editor.ownerDocument.createRange();
    caret.setStart(caretAnchor, caretAnchor.data.length);
    caret.collapse(true);
    setCaret(caret);
    closeMentionMenu();
    editor.focus();
    emitChange();
  }

  function openAssetMenu(): void {
    const editor = editorRef.current;
    if (!editor || disabled) return;
    editor.focus();
    let range = lastSelectionRef.current;
    if (!range || !range.commonAncestorContainer.isConnected || !editor.contains(range.commonAncestorContainer)) {
      range = editor.ownerDocument.createRange();
      range.selectNodeContents(editor);
      range.collapse(false);
    }
    const mention = mentionElementForNode(range.startContainer, editor);
    if (mention) {
      range = editor.ownerDocument.createRange();
      range.selectNode(mention);
    }
    setCaret(range);
    mentionRangeRef.current = range.cloneRange();
    setMentionQuery("");
    setActiveIndex(0);
  }

  function handleEditorInput(): void {
    emitChange();
    if (!composingRef.current) updateMentionFromSelection();
  }

  function handleEditorKeyDown(event: React.KeyboardEvent<HTMLDivElement>): void {
    if (composingRef.current || event.nativeEvent.isComposing || event.keyCode === 229) return;
    if (mentionQuery === null) return;
    if (event.key === "Escape") {
      event.preventDefault();
      event.stopPropagation();
      closeMentionMenu();
      return;
    }
    if (candidates.length === 0) return;
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault();
      const direction = event.key === "ArrowDown" ? 1 : -1;
      setActiveIndex((current) => (current + direction + candidates.length) % candidates.length);
    } else if (event.key === "Enter" || event.key === "Tab") {
      event.preventDefault();
      insertMention(candidates[Math.min(activeIndex, candidates.length - 1)] ?? candidates[0]);
    }
  }

  function handlePaste(event: React.ClipboardEvent<HTMLDivElement>): void {
    event.preventDefault();
    const editor = editorRef.current;
    const selection = editor?.ownerDocument.defaultView?.getSelection() ?? null;
    if (!editor || !selectionIsInside(editor, selection)) return;
    const text = event.clipboardData.getData("text/plain").replace(/\r\n?/g, "\n");
    const range = selection.getRangeAt(0);
    range.deleteContents();
    const fragment = editor.ownerDocument.createDocumentFragment();
    const lines = text.split("\n");
    let caretNode: Node | null = null;
    for (let index = 0; index < lines.length; index += 1) {
      const line = lines[index];
      const textNode = editor.ownerDocument.createTextNode(line);
      fragment.append(textNode);
      caretNode = textNode;
      if (index < lines.length - 1) {
        const br = editor.ownerDocument.createElement("br");
        fragment.append(br);
        caretNode = br;
      }
    }
    range.insertNode(fragment);
    const caret = editor.ownerDocument.createRange();
    if (caretNode?.nodeType === 3) caret.setStart(caretNode, (caretNode as Text).data.length);
    else if (caretNode) caret.setStartAfter(caretNode);
    else caret.setStart(range.endContainer, range.endOffset);
    caret.collapse(true);
    setCaret(caret);
    emitChange();
    updateMentionFromSelection();
  }

  const menuOpen = mentionQuery !== null;
  return (
    <div className={styles.root} ref={wrapperRef}>
      <div className={styles.toolbar}>
        <button
          type="button"
          className={styles.mentionButton}
          disabled={disabled}
          onMouseDown={(event) => event.preventDefault()}
          onClick={openAssetMenu}
        >
          <AtSign size={14} /> 引用项目资产
        </button>
        <span>{normalizedTargets.length} 项可引用 · 输入 @ 搜索</span>
      </div>
      <div
        className={styles.combobox}
        role="combobox"
        aria-label="项目资产引用编辑器"
        aria-haspopup="listbox"
        aria-expanded={menuOpen}
        aria-controls={menuOpen ? listboxId : undefined}
      >
        <div
          ref={editorRef}
          className={styles.editor}
          role="textbox"
          aria-label="剧本正文（可选）"
          aria-multiline="true"
          aria-autocomplete="list"
          aria-controls={menuOpen ? listboxId : undefined}
          aria-activedescendant={menuOpen && candidates.length > 0 ? `${listboxId}-${Math.min(activeIndex, candidates.length - 1)}` : undefined}
          aria-disabled={disabled}
          contentEditable={!disabled}
          data-placeholder="写下场景、动作或对白；输入 @ 可引用人物、场景、道具与媒体资产。"
          suppressContentEditableWarning
          spellCheck={false}
          onInput={handleEditorInput}
          onKeyDown={handleEditorKeyDown}
          onKeyUp={rememberSelection}
          onMouseUp={rememberSelection}
          onPaste={handlePaste}
          onCompositionStart={() => { composingRef.current = true; }}
          onCompositionEnd={() => { composingRef.current = false; emitChange(); updateMentionFromSelection(); }}
          onBlur={() => {
            window.setTimeout(() => {
              if (!wrapperRef.current?.contains(document.activeElement)) closeMentionMenu();
            }, 0);
          }}
        />
      </div>
      {menuOpen && (
        <div className={styles.menu} id={listboxId} role="listbox" aria-label="项目资产引用">
          <div className={styles.menuHeader}>
            <Search size={13} />
            <span>{mentionQuery ? `搜索“${mentionQuery}”` : "选择要引用的项目资产"}</span>
            <small>{candidates.length} 项</small>
          </div>
          <div className={styles.options}>
            {candidates.map((target, index) => (
              <button
                type="button"
                role="option"
                aria-selected={index === Math.min(activeIndex, candidates.length - 1)}
                id={`${listboxId}-${index}`}
                className={index === Math.min(activeIndex, candidates.length - 1) ? styles.activeOption : undefined}
                key={`${target.type}-${target.id}`}
                onMouseDown={(event) => event.preventDefault()}
                onMouseEnter={() => setActiveIndex(index)}
                onClick={() => insertMention(target)}
              >
                <span className={styles.targetAvatar} aria-hidden="true">{target.name.slice(0, 1)}</span>
                <span className={styles.targetCopy}>
                  <b>{target.name}</b>
                  <small>{targetTypeLabel(target)}{target.description ? ` · ${target.description}` : ""}</small>
                </span>
                {index === Math.min(activeIndex, candidates.length - 1) && <CornerDownLeft size={13} aria-hidden="true" />}
              </button>
            ))}
            {candidates.length === 0 && (
              <div className={styles.emptyResult}>没有匹配的项目资产，换个关键词试试。</div>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
