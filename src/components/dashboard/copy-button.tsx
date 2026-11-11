"use client";

// زر نسخ قابل لإعادة الاستخدام مع إشعار نجاح.

import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Check, Copy } from "lucide-react";
import { toast } from "sonner";

export default function CopyButton({ value, label = "نسخ", className }: { value: string; label?: string; className?: string }) {
  const [copied, setCopied] = useState(false);

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(value);
      setCopied(true);
      toast.success("تم النسخ إلى الحافظة");
      setTimeout(() => setCopied(false), 2000);
    } catch {
      toast.error("تعذر النسخ — انسخ يدويًا");
    }
  };

  return (
    <Button type="button" variant="outline" size="sm" onClick={copy} className={`gap-1.5 ${className ?? ""}`}>
      {copied ? <Check className="h-3.5 w-3.5 text-emerald-400" /> : <Copy className="h-3.5 w-3.5" />}
      {label}
    </Button>
  );
}
