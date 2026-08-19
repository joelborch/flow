import { useEffect, useImperativeHandle, useRef } from "preact/hooks";
import type { Ref } from "preact";
import { Editor } from "@tiptap/core";
import StarterKit from "@tiptap/starter-kit";
import Placeholder from "@tiptap/extension-placeholder";
import TaskList from "@tiptap/extension-task-list";
import TaskItem from "@tiptap/extension-task-item";
import { Table } from "@tiptap/extension-table";
import { TableRow } from "@tiptap/extension-table-row";
import { TableCell } from "@tiptap/extension-table-cell";
import { TableHeader } from "@tiptap/extension-table-header";
import { Image } from "@tiptap/extension-image";
import { Markdown } from "tiptap-markdown";
import { isSubmitChord } from "./autogrow.js";

export interface TipTapEditorHandle {
  save: () => void;
  cancel: () => void;
  getMarkdown: () => string | null;
}

interface TipTapEditorProps {
  initialValue: string;
  onSave: (markdown: string) => void;
  onCancel: () => void;
  editorHandleRef?: Ref<TipTapEditorHandle>;
  placeholder?: string;
  autofocus?: boolean;
}

export function TipTapEditor({
  initialValue,
  onSave,
  onCancel,
  editorHandleRef,
  placeholder = "Write it in markdown — headings, lists, code, links.",
  autofocus = true,
}: TipTapEditorProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const editorRef = useRef<Editor | null>(null);
  const dirtyRef = useRef(false);
  const onSaveRef = useRef(onSave);
  const onCancelRef = useRef(onCancel);

  onSaveRef.current = onSave;
  onCancelRef.current = onCancel;

  const getMarkdownSafely = (): string | null => {
    const editor = editorRef.current;
    if (!editor) return null;
    const storage = (editor.storage as any)?.markdown;
    if (!storage || typeof storage.getMarkdown !== "function") return null;
    return storage.getMarkdown();
  };

  const triggerSave = () => {
    if (!dirtyRef.current) {
      onCancelRef.current();
      return;
    }
    const md = getMarkdownSafely();
    if (md !== null) {
      onSaveRef.current(md);
    } else {
      onCancelRef.current();
    }
  };

  useImperativeHandle(
    editorHandleRef ?? null,
    () => ({
      save: () => {
        if (!dirtyRef.current) {
          onCancelRef.current();
          return;
        }
        const md = getMarkdownSafely();
        if (md !== null) {
          onSaveRef.current(md);
        } else {
          onCancelRef.current();
        }
      },
      cancel: () => onCancelRef.current(),
      getMarkdown: () => getMarkdownSafely(),
    }),
    []
  );

  useEffect(() => {
    if (!containerRef.current) return;

    const editor = new Editor({
      element: containerRef.current,
      autofocus: autofocus ? "end" : false,
      extensions: [
        StarterKit.configure({
          heading: {
            levels: [1, 2, 3, 4, 5, 6],
          },
        }),
        Table.configure({
          resizable: false,
        }),
        TableRow,
        TableHeader,
        TableCell,
        Image.configure({
          inline: true,
          allowBase64: false,
        }),
        TaskList,
        TaskItem.configure({
          nested: true,
        }),
        Placeholder.configure({
          placeholder,
        }),
        Markdown.configure({
          html: false,
          tightLists: true,
          bulletListMarker: "-",
          linkify: true,
          transformPastedText: true,
          transformCopiedText: true,
        }),
      ],
      content: initialValue,
      onUpdate: () => {
        dirtyRef.current = true;
      },
      editorProps: {
        attributes: {
          class: "tiptap focus:outline-none",
        },
        handleKeyDown: (_view, event) => {
          if (isSubmitChord(event)) {
            event.preventDefault();
            event.stopPropagation();
            if (!dirtyRef.current) {
              onCancelRef.current();
              return true;
            }
            const md = getMarkdownSafely();
            if (md !== null) {
              onSaveRef.current(md);
            } else {
              onCancelRef.current();
            }
            return true;
          }
          if (event.key === "Escape") {
            event.preventDefault();
            event.stopPropagation();
            onCancelRef.current();
            return true;
          }
          return false;
        },
      },
      onBlur: () => {
        triggerSave();
      },
    });

    editorRef.current = editor;

    return () => {
      editor.destroy();
      editorRef.current = null;
    };
  }, []);

  return (
    <div
      class="min-h-[180px] w-full rounded-xl border border-accent/40 bg-surface px-3.5 py-3 text-text ring-2 ring-accent/10 sm:px-4 sm:py-3.5"
      onMouseDown={(e) => {
        // Prevent clicking whitespace or padding around text from blurring and unmounting before focus
        const target = e.target as HTMLElement | null;
        if (target && !target.closest(".tiptap")) {
          e.preventDefault();
          if (editorRef.current && !editorRef.current.isFocused) {
            editorRef.current.commands.focus();
          }
        }
      }}
    >
      <div ref={containerRef} />
    </div>
  );
}
