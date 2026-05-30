/**
 * AttachmentBar — staged files waiting to be injected into the next chat message.
 *
 * Rendered inside the terminal wrapper in ChatPage.  Each chip shows:
 *   - image: a thumbnail preview
 *   - document: a file icon + filename
 *   - uploading/error states with appropriate indicators
 *   - × to remove
 */
import { AlertCircle, FileText, Image, Loader2, X } from "lucide-react";
import { cn } from "@/lib/utils";

export interface StagedAttachment {
  id: string;
  filename: string;
  previewUrl?: string; // blob URL for images
  type: "image" | "document";
  status: "uploading" | "ready" | "error";
  serverPath?: string; // set once the upload completes
}

interface AttachmentBarProps {
  attachments: StagedAttachment[];
  onRemove: (id: string) => void;
  className?: string;
}

export function AttachmentBar({
  attachments,
  onRemove,
  className,
}: AttachmentBarProps) {
  if (attachments.length === 0) return null;

  return (
    <div className={cn("flex flex-wrap gap-2 px-1 pt-2", className)}>
      {attachments.map((att) => (
        <div
          key={att.id}
          className={cn(
            "relative flex items-center gap-1.5 rounded border px-2 py-1.5 text-xs",
            "border-white/20 bg-black/30 text-white/80",
            att.status === "error" && "border-red-400/40 bg-red-900/20",
          )}
        >
          {/* Thumbnail or icon */}
          {att.type === "image" && att.previewUrl ? (
            <img
              src={att.previewUrl}
              alt={att.filename}
              className="h-7 w-7 rounded object-cover"
            />
          ) : att.type === "image" ? (
            <Image className="h-4 w-4 shrink-0 opacity-60" />
          ) : (
            <FileText className="h-4 w-4 shrink-0 opacity-60" />
          )}

          {/* Filename */}
          <span className="max-w-[140px] truncate leading-none">
            {att.filename}
          </span>

          {/* Status indicators */}
          {att.status === "uploading" && (
            <Loader2 className="h-3 w-3 shrink-0 animate-spin opacity-60" />
          )}
          {att.status === "error" && (
            <span title="Upload failed — file will not be attached">
              <AlertCircle className="h-3 w-3 shrink-0 text-red-400" />
            </span>
          )}

          {/* Remove button */}
          <button
            type="button"
            onClick={() => onRemove(att.id)}
            className="ml-0.5 rounded p-0.5 opacity-50 hover:bg-white/20 hover:opacity-100 transition-opacity"
            aria-label={`Remove ${att.filename}`}
          >
            <X className="h-3 w-3" />
          </button>
        </div>
      ))}
    </div>
  );
}
