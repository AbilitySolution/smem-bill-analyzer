"use client";

import { useTransition } from "react";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Button } from "@/components/ui/button";
import { TagBadges, type TagInfo } from "./tag-badges";
import { toggleInvoiceTag } from "@/app/(app)/factures/[id]/actions";
import { Tag as TagIcon } from "lucide-react";
import { TAG_COLOR_CLASSES } from "@/lib/format";

export function InvoiceTagPicker({
  invoiceId,
  allTags,
  activeTagIds,
}: {
  invoiceId: string;
  allTags: TagInfo[];
  activeTagIds: string[];
}) {
  const [pending, startTransition] = useTransition();
  const activeTags = allTags.filter((t) => activeTagIds.includes(t.id));

  function toggle(tagId: string, checked: boolean) {
    startTransition(async () => {
      await toggleInvoiceTag(invoiceId, tagId, checked);
    });
  }

  return (
    <Popover>
      <PopoverTrigger
        render={
          <Button variant="outline" size="sm">
            <TagIcon className="size-3.5" />
            Étiquettes
          </Button>
        }
      />
      <PopoverContent className="w-56 p-2">
        <div className="mb-2">
          <TagBadges tags={activeTags} />
        </div>
        <div className="space-y-1">
          {allTags.map((tag) => {
            const checked = activeTagIds.includes(tag.id);
            return (
              <label
                key={tag.id}
                className="flex cursor-pointer items-center gap-2 rounded px-1.5 py-1 text-sm hover:bg-slate-50"
              >
                <input
                  type="checkbox"
                  checked={checked}
                  disabled={pending}
                  onChange={(e) => toggle(tag.id, e.target.checked)}
                  className="size-3.5"
                />
                <span
                  className={`size-2 rounded-full ${TAG_COLOR_CLASSES[tag.color]?.split(" ")[0] ?? ""}`}
                />
                {tag.label}
              </label>
            );
          })}
        </div>
      </PopoverContent>
    </Popover>
  );
}
