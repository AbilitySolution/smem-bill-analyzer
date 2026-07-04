"use client";

import { useRouter, useSearchParams, usePathname } from "next/navigation";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Search } from "lucide-react";

export function FacturesFilterBar({
  communes,
}: {
  communes: { id: string; nom: string }[];
}) {
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();

  function setParam(key: string, value: string | null) {
    const params = new URLSearchParams(searchParams.toString());
    if (value && value !== "all") {
      params.set(key, value);
    } else {
      params.delete(key);
    }
    router.push(`${pathname}?${params.toString()}`);
  }

  return (
    <div className="flex flex-wrap items-center gap-3">
      <Tabs
        value={searchParams.get("categorie") ?? "all"}
        onValueChange={(v) => setParam("categorie", v)}
      >
        <TabsList>
          <TabsTrigger value="all">Toutes</TabsTrigger>
          <TabsTrigger value="batiment">Bâtiments</TabsTrigger>
          <TabsTrigger value="eclairage_public">Éclairage public</TabsTrigger>
        </TabsList>
      </Tabs>

      <Select
        value={searchParams.get("commune") ?? "all"}
        onValueChange={(v) => setParam("commune", v)}
      >
        <SelectTrigger className="w-48">
          <SelectValue placeholder="Toutes les communes" />
        </SelectTrigger>
        <SelectContent>
          <SelectItem value="all">Toutes les communes</SelectItem>
          {communes.map((c) => (
            <SelectItem key={c.id} value={c.id}>
              {c.nom}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>

      <div className="relative ml-auto w-64">
        <Search className="absolute left-2.5 top-2.5 size-4 text-slate-400" />
        <Input
          placeholder="Rechercher (n° facture, site...)"
          defaultValue={searchParams.get("q") ?? ""}
          className="pl-8"
          onChange={(e) => setParam("q", e.target.value || null)}
        />
      </div>
    </div>
  );
}
