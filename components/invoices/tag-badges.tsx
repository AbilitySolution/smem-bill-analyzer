import { Badge } from "@/components/ui/badge";
import { TAG_COLOR_CLASSES } from "@/lib/format";

export interface TagInfo {
  id: string;
  label: string;
  color: string;
}

export function TagBadges({ tags }: { tags: TagInfo[] }) {
  if (!tags.length) return null;
  return (
    <div className="flex flex-wrap gap-1">
      {tags.map((tag) => (
        <Badge
          key={tag.id}
          variant="outline"
          className={`border text-[11px] ${TAG_COLOR_CLASSES[tag.color] ?? TAG_COLOR_CLASSES.gray}`}
        >
          {tag.label}
        </Badge>
      ))}
    </div>
  );
}
