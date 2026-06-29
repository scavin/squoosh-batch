// FRONTEND-DESIGN (hand-crafted): Editorial Utility / "Batch Squoosh"
// Principles:
// - One dominant workspace card: empty state = dropzone; filled = locked list
// - Clear hierarchy: global controls top, parameters left rail, results right
// - Results cards: Title -> Compare previews -> Two-column info (input vs output)

import { useEffect, useMemo, useRef, useState } from "react";
import { nanoid } from "nanoid";
import JSZip from "jszip";
import { saveAs } from "file-saver";

import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Slider } from "@/components/ui/slider";
import { Switch } from "@/components/ui/switch";
import { Progress } from "@/components/ui/progress";
import { Accordion, AccordionContent, AccordionItem, AccordionTrigger } from "@/components/ui/accordion";
import { Separator } from "@/components/ui/separator";
import { ScrollArea } from "@/components/ui/scroll-area";
import { toast } from "sonner";

import { closeWorkerPool, type BatchParams, type OutputFormat, processWithSquoosh } from "@/lib/imageProcessing";

import {
  Check,
  CloudDownload,
  FileImage,
  FolderOpen,
  Loader2,
  SquareArrowOutUpRight,
  Trash2,
  X,
  Zap,
} from "lucide-react";

interface QueueItem {
  id: string;
  file: File;
  inputUrl: string;
  fileName: string;
  relativePath?: string;
  inputSize: number;
  status: "queued" | "processing" | "done" | "error";
  error?: string;
  inWidth?: number;
  inHeight?: number;
  outWidth?: number;
  outHeight?: number;
  outputUrl?: string;
  outputBlob?: Blob;
  outputSize?: number;
  outputExt?: string;
}

const DEFAULT_PARAMS: BatchParams = {
  format: "avif",
  quality: 80,
  webpMethod: 4,
  avifCqLevel: 30,
  pngEffort: 3,
  resize: {
    enabled: false,
    keepAspect: true,
    width: 1200,
    height: undefined,
  },
};

function formatBytes(bytes: number) {
  if (!Number.isFinite(bytes)) return "-";
  const units = ["B", "KB", "MB", "GB"];
  let b = bytes;
  let i = 0;
  while (b >= 1024 && i < units.length - 1) {
    b /= 1024;
    i++;
  }
  return `${b.toFixed(i === 0 ? 0 : 2)} ${units[i]}`;
}

function ratioText(before: number, after: number) {
  if (!before || !after) return "-";
  const saved = 1 - after / before;
  return `${(saved * 100).toFixed(1)}%`;
}

function baseName(name: string) {
  return name.replace(/\.[^.]+$/, "");
}

function leafName(name: string) {
  return name.split("/").pop() || name;
}

function outputFileName(it: QueueItem, preservePath: boolean) {
  const sourceName = preservePath ? it.relativePath || it.fileName : leafName(it.fileName);
  const ext = (it.outputExt || ".bin").startsWith(".") ? it.outputExt! : `.${it.outputExt}`;
  return `${baseName(sourceName)}${ext}`;
}

function isImageFile(file: File) {
  if (file.type.startsWith("image/")) return true;
  return /\.(avif|bmp|gif|heic|heif|jpe?g|png|tiff?|webp)$/i.test(file.name);
}

function errorMessage(error: unknown, fallback: string) {
  return error instanceof Error && error.message ? error.message : fallback;
}

type FileWithPath = { file: File; relativePath?: string };

async function fileFromEntry(entry: FileSystemFileEntry) {
  return new Promise<File>((resolve, reject) => entry.file(resolve, reject));
}

async function readDirectoryEntries(entry: FileSystemDirectoryEntry) {
  const reader = entry.createReader();
  const entries: FileSystemEntry[] = [];

  while (true) {
    const batch = await new Promise<FileSystemEntry[]>((resolve, reject) => {
      reader.readEntries(resolve, reject);
    });
    if (!batch.length) break;
    entries.push(...batch);
  }

  return entries;
}

async function collectFilesFromEntry(
  entry: FileSystemEntry,
  parentPath = "",
): Promise<Array<FileWithPath & { relativePath: string }>> {
  const relativePath = parentPath ? `${parentPath}/${entry.name}` : entry.name;

  if (entry.isFile) {
    const file = await fileFromEntry(entry as FileSystemFileEntry);
    return [{ file, relativePath }];
  }

  if (!entry.isDirectory) return [];

  const children = await readDirectoryEntries(entry as FileSystemDirectoryEntry);
  const nested = await Promise.all(children.map((child) => collectFilesFromEntry(child, relativePath)));
  return nested.flat();
}

async function collectFilesFromDataTransfer(dataTransfer: DataTransfer) {
  const entries = Array.from(dataTransfer.items || [])
    .map((item) => item.webkitGetAsEntry?.())
    .filter((entry): entry is FileSystemEntry => Boolean(entry));

  if (!entries.length) {
    return Array.from(dataTransfer.files).map((file) => ({
      file,
      relativePath: (file as File & { webkitRelativePath?: string }).webkitRelativePath || file.name,
    }));
  }

  const files = await Promise.all(entries.map((entry) => collectFilesFromEntry(entry)));
  return files.flat();
}

export default function Home() {
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const folderInputRef = useRef<HTMLInputElement | null>(null);
  const [items, setItems] = useState<QueueItem[]>([]);
  const [params, setParams] = useState<BatchParams>(DEFAULT_PARAMS);
  const [isProcessing, setIsProcessing] = useState(false);
  const [processedCount, setProcessedCount] = useState(0);

  const stats = useMemo(() => {
    const done = items.filter((i) => i.status === "done").length;
    const err = items.filter((i) => i.status === "error").length;
    const total = items.length;
    const inTotal = items.reduce((s, i) => s + (i.inputSize || 0), 0);
    const outTotal = items.reduce((s, i) => s + (i.outputSize || 0), 0);
    return { done, err, total, inTotal, outTotal };
  }, [items]);

  const progress = useMemo(() => {
    if (!items.length) return 0;
    const finished = items.filter((i) => i.status === "done" || i.status === "error").length;
    return Math.round((finished / items.length) * 100);
  }, [items]);

  useEffect(() => {
    return () => {
      for (const it of items) {
        URL.revokeObjectURL(it.inputUrl);
        if (it.outputUrl) URL.revokeObjectURL(it.outputUrl);
      }
      void closeWorkerPool();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function addFiles(fileList: FileList | File[] | FileWithPath[]) {
    if (items.length) return; // locked mode
    const raw = Array.from(fileList as ArrayLike<File | FileWithPath>);
    const incoming = raw.map((item) => {
      if (item instanceof File) {
        return {
          file: item,
          relativePath: (item as File & { webkitRelativePath?: string }).webkitRelativePath || item.name,
        };
      }
      return {
        file: item.file,
        relativePath: item.relativePath || (item.file as File & { webkitRelativePath?: string }).webkitRelativePath || item.file.name,
      };
    });
    const files = incoming.filter(({ file }) => isImageFile(file));
    if (!files.length) return;

    const added: QueueItem[] = files.map(({ file, relativePath }) => ({
      id: nanoid(),
      file,
      inputUrl: URL.createObjectURL(file),
      fileName: relativePath || file.name,
      relativePath,
      inputSize: file.size,
      status: "queued",
    }));

    setItems((prev) => [...prev, ...added]);
    toast.success(`已加入 ${added.length} 张图片（队列已锁定）`);
  }

  function removeItem(id: string) {
    setItems((prev) => {
      const t = prev.find((x) => x.id === id);
      if (t) {
        URL.revokeObjectURL(t.inputUrl);
        if (t.outputUrl) URL.revokeObjectURL(t.outputUrl);
      }
      return prev.filter((x) => x.id !== id);
    });
  }

  function clearAll() {
    setItems((prev) => {
      for (const it of prev) {
        URL.revokeObjectURL(it.inputUrl);
        if (it.outputUrl) URL.revokeObjectURL(it.outputUrl);
      }
      return [];
    });
    setProcessedCount(0);
  }

  function reprocessAll() {
    setItems((prev) =>
      prev.map((it) => {
        if (it.outputUrl) URL.revokeObjectURL(it.outputUrl);
        return {
          ...it,
          status: "queued",
          error: undefined,
          outputUrl: undefined,
          outputBlob: undefined,
          outputSize: undefined,
          outputExt: undefined,
          outWidth: undefined,
          outHeight: undefined,
        };
      }),
    );
    setProcessedCount(0);
    toast.message("已重置为待处理");
  }

  async function handleProcessAll() {
    if (!items.length) {
      toast.message("先添加一些图片");
      return;
    }
    if (isProcessing) return;

    setIsProcessing(true);
    setProcessedCount(0);
    const toastId = toast.loading("开始批量处理…");

    try {
      const toProcess = items.filter((i) => i.status === "queued" || i.status === "error");
      if (!toProcess.length) {
        toast.dismiss(toastId);
        toast.message("没有需要处理的图片");
        setIsProcessing(false);
        return;
      }

      setItems((prev) =>
        prev.map((it) =>
          it.status === "queued" || it.status === "error" ? { ...it, status: "processing", error: undefined } : it,
        ),
      );

      const threads = Math.max(1, Math.min(8, navigator.hardwareConcurrency || 4));
      const batchSize = Math.max(4, threads * 2);

      for (let i = 0; i < toProcess.length; i += batchSize) {
        const batch = toProcess.slice(i, i + batchSize);
        await Promise.all(
          batch.map(async (it) => {
            try {
              const buf = await it.file.arrayBuffer();
              const { processed, meta } = await processWithSquoosh(buf, params, it.file.type);
              setItems((prev) =>
                prev.map((x) => {
                  if (x.id !== it.id) return x;
                  if (x.outputUrl) URL.revokeObjectURL(x.outputUrl);
                  return {
                    ...x,
                    status: "done",
                    inWidth: meta.inWidth,
                    inHeight: meta.inHeight,
                    outWidth: processed.outWidth,
                    outHeight: processed.outHeight,
                    outputUrl: processed.outputUrl,
                    outputBlob: processed.outputBlob,
                    outputSize: processed.outputSize,
                    outputExt: processed.outputExt,
                    error: undefined,
                  };
                }),
              );
              setProcessedCount((c) => c + 1);
            } catch (e: unknown) {
              const msg = errorMessage(e, "处理失败");
              setItems((prev) => prev.map((x) => (x.id === it.id ? { ...x, status: "error", error: msg } : x)));
              setProcessedCount((c) => c + 1);
            }
          }),
        );
      }

      toast.dismiss(toastId);
      toast.success("批量处理完成");
    } catch (e: unknown) {
      toast.dismiss(toastId);
      toast.error(errorMessage(e, "批量处理失败"));
    } finally {
      setIsProcessing(false);
    }
  }

  async function downloadOne(it: QueueItem) {
    if (!it.outputBlob) {
      toast.message("这张图还没处理完成");
      return;
    }
    saveAs(it.outputBlob, outputFileName(it, false));
  }

  async function downloadZipAll() {
    const done = items.filter((i) => i.status === "done" && i.outputBlob);
    if (!done.length) {
      toast.message("还没有可下载的结果");
      return;
    }

    const toastId = toast.loading("正在打包 ZIP…");
    try {
      const zip = new JSZip();
      for (const it of done) {
        zip.file(outputFileName(it, true), it.outputBlob!);
      }
      const blob = await zip.generateAsync({ type: "blob" });
      const dt = new Date();
      const tag = `${dt.getFullYear()}${String(dt.getMonth() + 1).padStart(2, "0")}${String(dt.getDate()).padStart(2, "0")}-${String(dt.getHours()).padStart(2, "0")}${String(dt.getMinutes()).padStart(2, "0")}`;
      saveAs(blob, `squoosh-batch-${tag}.zip`);
      toast.dismiss(toastId);
      toast.success("ZIP 已生成");
    } catch (e: unknown) {
      toast.dismiss(toastId);
      toast.error(errorMessage(e, "ZIP 打包失败"));
    }
  }

  const DropZone = (
    <div
      className="relative overflow-hidden rounded-2xl border border-border bg-card"
      onDragOver={(e) => {
        if (items.length) return;
        e.preventDefault();
        e.stopPropagation();
      }}
      onDrop={async (e) => {
        if (items.length) return;
        e.preventDefault();
        e.stopPropagation();
        if (!e.dataTransfer) return;
        const toastId = toast.loading("正在读取拖入内容…");
        try {
          const files = await collectFilesFromDataTransfer(e.dataTransfer);
          toast.dismiss(toastId);
          await addFiles(files);
        } catch (err: unknown) {
          toast.dismiss(toastId);
          toast.error(errorMessage(err, "读取拖入文件夹失败"));
        }
      }}
    >
      <div className="absolute inset-0 bg-[radial-gradient(circle_at_20%_20%,oklch(0.52_0.20_145/.16),transparent_55%),radial-gradient(circle_at_80%_30%,oklch(0.65_0.21_35/.10),transparent_55%)]" />
      <div className="relative p-6 md:p-10">
        <div className="flex flex-col md:flex-row md:items-center gap-5">
          <div className="flex items-center gap-3">
            <div className="grid h-12 w-12 place-items-center rounded-xl border border-border bg-background">
              <FileImage className="h-6 w-6" />
            </div>
            <div>
              <div className="text-xl font-semibold tracking-tight">把图片拖到这里</div>
              <div className="mt-1 text-sm text-muted-foreground">
                支持拖入图片或文件夹 · JPG / PNG / WebP / AVIF · 加入后队列将锁定
              </div>
            </div>
          </div>

          <div className="md:ml-auto flex items-center gap-2">
            <Button type="button" variant="secondary" onClick={() => fileInputRef.current?.click()}>
              选择文件
            </Button>
            <Button type="button" variant="secondary" className="gap-2" onClick={() => folderInputRef.current?.click()}>
              <FolderOpen className="h-4 w-4" />
              选择文件夹
            </Button>
            <input
              ref={fileInputRef}
              type="file"
              multiple
              accept="image/*"
              className="hidden"
              onChange={(e) => {
                if (e.target.files) void addFiles(e.target.files);
                e.currentTarget.value = "";
              }}
            />
            <input
              ref={folderInputRef}
              type="file"
              multiple
              accept="image/*"
              className="hidden"
              {...{ webkitdirectory: "", directory: "" }}
              onChange={(e) => {
                if (e.target.files) void addFiles(e.target.files);
                e.currentTarget.value = "";
              }}
            />
          </div>
        </div>
      </div>
    </div>
  );

  return (
    <div className="min-h-screen bg-background text-foreground">
      <div className="mx-auto max-w-[1480px] px-4 py-6 md:px-6 md:py-10">
        {/* Top header */}
        <div className="flex flex-col gap-4 lg:flex-row lg:items-end lg:justify-between">
          <div>
            <div className="inline-flex items-center gap-2 rounded-full border border-border bg-card px-3 py-1 text-xs text-muted-foreground">
              <span className="inline-block h-2 w-2 rounded-full bg-primary" />
              本地运行 · 不上传 · WASM + Worker
            </div>
            <h1 className="mt-3 text-3xl md:text-4xl font-bold tracking-tight">
              批量版 <span className="text-primary">Squoosh</span>
            </h1>
            <p className="mt-2 max-w-[70ch] text-sm md:text-base text-muted-foreground">
              统一参数批量压缩/转码：预览对比、单张下载、ZIP 打包。拖入后队列锁定，专注处理。
            </p>
          </div>

          <div className="flex flex-wrap items-center gap-2">
            <Button type="button" onClick={handleProcessAll} disabled={!items.length || isProcessing} className="gap-2">
              {isProcessing ? <Loader2 className="h-4 w-4 animate-spin" /> : <Zap className="h-4 w-4" />}
              开始处理
            </Button>
            <Button type="button" variant="outline" onClick={reprocessAll} disabled={!items.length || isProcessing}>
              重新处理
            </Button>
            <Button type="button" variant="outline" onClick={downloadZipAll} className="gap-2" disabled={!items.some((i) => i.status === "done")}>
              <CloudDownload className="h-4 w-4" />
              下载 ZIP
            </Button>
            <Button type="button" variant="destructive" onClick={clearAll} className="gap-2" disabled={!items.length || isProcessing}>
              <Trash2 className="h-4 w-4" />
              清空
            </Button>
          </div>
        </div>

        <div className="mt-6 grid grid-cols-1 lg:grid-cols-[380px_1fr] gap-6">
          {/* Left rail */}
          <Card className="order-2 h-fit p-5 md:p-6 lg:order-1 lg:sticky lg:top-6">
            <div className="flex items-center justify-between">
              <div className="text-sm font-semibold tracking-wide">参数</div>
              <div className="text-xs text-muted-foreground font-mono">MVP</div>
            </div>
            <Separator className="my-4" />

            <div className="space-y-5">
              <div className="space-y-2">
                <Label>输出格式</Label>
                <Select value={params.format} onValueChange={(v) => setParams((p) => ({ ...p, format: v as OutputFormat }))}>
                  <SelectTrigger>
                    <SelectValue placeholder="选择输出格式" />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="webp">WebP（推荐）</SelectItem>
                    <SelectItem value="avif">AVIF（更高压缩）</SelectItem>
                    <SelectItem value="jpeg">JPEG（兼容）</SelectItem>
                    <SelectItem value="png">PNG（无损/优化）</SelectItem>
                  </SelectContent>
                </Select>
              </div>

              <div className="space-y-2">
                <div className="flex items-center justify-between">
                  <Label>质量</Label>
                  <span className="font-mono text-xs text-muted-foreground">{params.quality}</span>
                </div>
                <Slider value={[params.quality]} min={0} max={100} step={1} onValueChange={(v) => setParams((p) => ({ ...p, quality: v[0] }))} />
                <div className="text-xs text-muted-foreground">WebP/JPEG 越高越清晰；AVIF 将质量映射为 cqLevel（可在高级参数改）。</div>
              </div>

              <div className="rounded-xl border border-border p-4">
                <div className="flex items-center justify-between">
                  <div className="space-y-0.5">
                    <div className="text-sm font-medium">Resize</div>
                    <div className="text-xs text-muted-foreground">可只填宽度，按比例缩放</div>
                  </div>
                  <Switch checked={params.resize.enabled} onCheckedChange={(v) => setParams((p) => ({ ...p, resize: { ...p.resize, enabled: v } }))} />
                </div>

                <div className={`mt-4 grid grid-cols-2 gap-3 ${params.resize.enabled ? "" : "opacity-50 pointer-events-none"}`}>
                  <div className="space-y-1">
                    <Label className="text-xs">宽度</Label>
                    <Input
                      inputMode="numeric"
                      value={params.resize.width ?? ""}
                      onChange={(e) => setParams((p) => ({ ...p, resize: { ...p.resize, width: e.target.value ? Number(e.target.value) : undefined } }))}
                      placeholder="例如 1200"
                    />
                  </div>
                  <div className="space-y-1">
                    <Label className="text-xs">高度</Label>
                    <Input
                      inputMode="numeric"
                      value={params.resize.height ?? ""}
                      onChange={(e) => setParams((p) => ({ ...p, resize: { ...p.resize, height: e.target.value ? Number(e.target.value) : undefined } }))}
                      placeholder="可留空"
                    />
                  </div>
                </div>

                <div className={`mt-3 flex items-center justify-between ${params.resize.enabled ? "" : "opacity-50 pointer-events-none"}`}>
                  <Label className="text-xs">保持宽高比</Label>
                  <Switch checked={params.resize.keepAspect} onCheckedChange={(v) => setParams((p) => ({ ...p, resize: { ...p.resize, keepAspect: v } }))} />
                </div>
              </div>

              <Accordion type="single" collapsible>
                <AccordionItem value="adv">
                  <AccordionTrigger>高级参数</AccordionTrigger>
                  <AccordionContent>
                    <div className="space-y-4">
                      <div className="space-y-2">
                        <div className="flex items-center justify-between">
                          <Label>WebP method</Label>
                          <span className="font-mono text-xs text-muted-foreground">{params.webpMethod ?? 4}</span>
                        </div>
                        <Slider value={[params.webpMethod ?? 4]} min={0} max={6} step={1} onValueChange={(v) => setParams((p) => ({ ...p, webpMethod: v[0] }))} />
                        <div className="text-xs text-muted-foreground">越高越慢但压缩更好（主要对 WebP 生效）。</div>
                      </div>

                      <div className="space-y-2">
                        <div className="flex items-center justify-between">
                          <Label>AVIF cqLevel</Label>
                          <span className="font-mono text-xs text-muted-foreground">{params.avifCqLevel ?? 30}</span>
                        </div>
                        <Slider value={[params.avifCqLevel ?? 30]} min={0} max={63} step={1} onValueChange={(v) => setParams((p) => ({ ...p, avifCqLevel: v[0] }))} />
                        <div className="text-xs text-muted-foreground">数值越低质量越好、体积越大。</div>
                      </div>

                      <div className="space-y-2">
                        <div className="flex items-center justify-between">
                          <Label>PNG effort</Label>
                          <span className="font-mono text-xs text-muted-foreground">{params.pngEffort ?? 3}</span>
                        </div>
                        <Slider value={[params.pngEffort ?? 3]} min={0} max={6} step={1} onValueChange={(v) => setParams((p) => ({ ...p, pngEffort: v[0] }))} />
                      </div>
                    </div>
                  </AccordionContent>
                </AccordionItem>
              </Accordion>

              <Separator />

              <div className="space-y-2">
                <div className="flex items-center justify-between text-sm">
                  <span className="text-muted-foreground">队列</span>
                  <span className="font-mono">{stats.total}</span>
                </div>
                <div className="flex items-center justify-between text-sm">
                  <span className="text-muted-foreground">完成</span>
                  <span className="font-mono">{stats.done}</span>
                </div>
                <div className="flex items-center justify-between text-sm">
                  <span className="text-muted-foreground">失败</span>
                  <span className="font-mono">{stats.err}</span>
                </div>
                <div className="pt-1">
                  <Progress value={progress} />
                  <div className="mt-2 flex items-center justify-between text-xs text-muted-foreground font-mono">
                    <span>
                      {formatBytes(stats.inTotal)} → {formatBytes(stats.outTotal || 0)}
                    </span>
                    <span>{progress}%</span>
                  </div>
                </div>
                <div className="text-[11px] text-muted-foreground">所有处理都在浏览器本地完成，不会上传图片。</div>
              </div>
            </div>
          </Card>

          {/* Workspace */}
          <Card className="order-1 p-4 md:p-5 lg:order-2">
            <div className="flex items-center justify-between gap-3 flex-wrap">
              <div className="text-sm font-semibold">工作区</div>
              <div className="flex items-center gap-2">
                {items.length ? (
                  <Button type="button" variant="secondary" onClick={clearAll} disabled={isProcessing}>
                    清空并继续拖拽
                  </Button>
                ) : null}
                <div className="text-xs text-muted-foreground font-mono">
                  {items.length ? (isProcessing ? `处理中：${processedCount}/${items.length}` : "等待处理") : "拖拽添加"}
                </div>
              </div>
            </div>
            <Separator className="my-4" />

            {!items.length ? (
              <div className="space-y-4">
                {DropZone}
                <div className="rounded-xl border border-border bg-muted/40 p-4 text-sm text-muted-foreground">
                  <div className="flex items-center gap-2">
                    <SquareArrowOutUpRight className="h-4 w-4" />
                    <span>
                      设计为“锁定队列”工作流：添加后不再允许继续拖拽，避免混入新文件影响对比。
                    </span>
                  </div>
                </div>
              </div>
            ) : (
              <ScrollArea className="h-[68vh] pr-2">
                <div className="grid grid-cols-1 xl:grid-cols-2 gap-4">
                  {items.map((it) => (
                    <div key={it.id} className="rounded-2xl border border-border bg-card p-4">
                      {/* Title */}
                      <div className="flex items-start justify-between gap-3">
                        <div className="min-w-0">
                          <div className="truncate text-[15px] font-semibold tracking-tight">{it.fileName}</div>
                          <div className="mt-1 text-xs text-muted-foreground">
                            {it.status === "processing" ? (
                              <span className="inline-flex items-center gap-1">
                                <Loader2 className="h-3.5 w-3.5 animate-spin" /> 处理中
                              </span>
                            ) : it.status === "done" ? (
                              <span className="inline-flex items-center gap-1 text-primary">
                                <Check className="h-3.5 w-3.5" /> 已完成
                              </span>
                            ) : it.status === "error" ? (
                              <span className="text-destructive">失败：{it.error || "-"}</span>
                            ) : (
                              <span className="inline-flex items-center gap-1">
                                <Zap className="h-3.5 w-3.5" /> 等待
                              </span>
                            )}
                          </div>
                        </div>

                        <div className="flex items-center gap-1">
                          <Button type="button" size="icon" variant="ghost" onClick={() => removeItem(it.id)} aria-label="删除">
                            <X className="h-4 w-4" />
                          </Button>
                        </div>
                      </div>

                      {/* Compare */}
                      <div className="mt-4 grid grid-cols-2 gap-3">
                        <div className="rounded-xl border border-border bg-background overflow-hidden">
                          <div className="px-2.5 py-1.5 text-[11px] text-muted-foreground border-b border-border">原图</div>
                          <div className="aspect-[4/3] bg-muted flex items-center justify-center overflow-hidden">
                            <img src={it.inputUrl} alt="input" className="h-full w-full object-contain" loading="lazy" />
                          </div>
                        </div>

                        <div className="rounded-xl border border-border bg-background overflow-hidden">
                          <div className="px-2.5 py-1.5 text-[11px] text-muted-foreground border-b border-border">输出</div>
                          <div className="aspect-[4/3] bg-muted flex items-center justify-center overflow-hidden">
                            {it.outputUrl ? (
                              <img src={it.outputUrl} alt="output" className="h-full w-full object-contain" loading="lazy" />
                            ) : (
                              <div className="text-xs text-muted-foreground flex items-center gap-2">
                                {it.status === "processing" ? (
                                  <>
                                    <Loader2 className="h-4 w-4 animate-spin" />
                                    处理中…
                                  </>
                                ) : it.status === "error" ? (
                                  <>
                                    <X className="h-4 w-4" />
                                    失败
                                  </>
                                ) : (
                                  <>
                                    <Zap className="h-4 w-4" />
                                    等待
                                  </>
                                )}
                              </div>
                            )}
                          </div>
                        </div>
                      </div>

                      {/* Info compare */}
                      <div className="mt-3 grid grid-cols-2 gap-3">
                        <div className="rounded-xl border border-border bg-background px-3 py-2">
                          <div className="text-[11px] text-muted-foreground">原图信息</div>
                          <div className="mt-1 font-mono text-sm md:text-base leading-snug">
                            <div>
                              <span className="text-muted-foreground">大小：</span>
                              <span className="text-foreground font-semibold">{formatBytes(it.inputSize)}</span>
                            </div>
                            <div>
                              <span className="text-muted-foreground">尺寸：</span>
                              <span className="text-foreground font-semibold">
                                {typeof it.inWidth === "number" && typeof it.inHeight === "number" ? `${it.inWidth}×${it.inHeight}` : "-"}
                              </span>
                            </div>
                          </div>
                        </div>

                        <div className="rounded-xl border border-border bg-background px-3 py-2">
                          <div className="text-[11px] text-muted-foreground">输出信息</div>
                          <div className="mt-1 font-mono text-sm md:text-base leading-snug">
                            <div>
                              <span className="text-muted-foreground">大小：</span>
                              <span className="text-primary font-semibold">
                                {it.status === "done" && it.outputSize ? formatBytes(it.outputSize) : "-"}
                              </span>
                            </div>
                            {it.status === "done" && it.outputSize ? (
                              <div className="mt-0.5 text-xs text-muted-foreground">节省 {ratioText(it.inputSize, it.outputSize)}</div>
                            ) : null}
                            <div>
                              <span className="text-muted-foreground">尺寸：</span>
                              <span className="text-primary font-semibold">
                                {it.status === "done" && typeof it.outWidth === "number" && typeof it.outHeight === "number" ? `${it.outWidth}×${it.outHeight}` : "-"}
                              </span>
                            </div>
                          </div>
                        </div>
                      </div>

                      {/* Actions */}
                      <div className="mt-4 flex items-center justify-between gap-3">
                        <div className="text-xs text-muted-foreground font-mono">
                          {it.status === "done" && it.outputSize ? `输出体积：${formatBytes(it.outputSize)}` : it.status === "error" ? "可重试" : ""}
                        </div>
                        <Button type="button" variant="secondary" disabled={it.status !== "done"} onClick={() => downloadOne(it)}>
                          下载
                        </Button>
                      </div>
                    </div>
                  ))}
                </div>
              </ScrollArea>
            )}
          </Card>
        </div>

        <footer className="mt-10 text-xs text-muted-foreground">
          <Separator className="mb-4" />
          <div className="flex flex-col md:flex-row md:items-center md:justify-between gap-2">
            <div className="font-mono">提示：大批量/大分辨率图片可能占用较多内存，建议分批处理。</div>
            <div className="font-mono">Powered by jSquash (Squoosh codecs) · JSZip</div>
          </div>
        </footer>
      </div>
    </div>
  );
}
