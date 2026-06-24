"use client";

import * as React from "react";
import { ArrowUp, Settings } from "lucide-react";
import { toast } from "sonner";

import { Avatar, AvatarFallback } from "@/components/ui/avatar";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import { Skeleton } from "@/components/ui/skeleton";
import { Switch } from "@/components/ui/switch";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Textarea } from "@/components/ui/textarea";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";

function Section({
  title,
  children,
}: {
  title: string;
  children: React.ReactNode;
}) {
  return (
    <section className="flex flex-col gap-4 rounded-[var(--r-lg)] border border-border bg-surface p-6 shadow-[var(--shadow-sm)]">
      <h2 className="mono-label text-text-muted">{title}</h2>
      <div className="flex flex-wrap items-center gap-4">{children}</div>
    </section>
  );
}

/**
 * Live preview of every re-skinned shadcn component (frontend-specs §4). If any
 * of these read as stock shadcn, the theme bridge is broken.
 */
export function ComponentPreview() {
  return (
    <div className="flex flex-col gap-6">
      <Section title="Buttons">
        <Button>Publish</Button>
        <Button variant="secondary">Cancel</Button>
        <Button variant="ghost">Skip</Button>
        <Button variant="destructive">Delete</Button>
        <Button variant="link">
          <ArrowUp />
          Drop a file or browse
        </Button>
      </Section>

      <Section title="Badges">
        <Badge>accent</Badge>
        <Badge variant="outline">outline</Badge>
        <Badge variant="live">live</Badge>
        <Badge variant="warning">resting</Badge>
        <Badge variant="danger">suspended</Badge>
      </Section>

      <Section title="Inputs">
        <div className="flex w-full max-w-sm flex-col gap-2">
          <Label htmlFor="slug">Page slug</Label>
          <Input id="slug" placeholder="my-page" />
          <Textarea placeholder="Notes…" />
          <div className="flex items-center gap-3">
            <Switch id="public" defaultChecked />
            <Label htmlFor="public">Public</Label>
          </div>
        </div>
      </Section>

      <Section title="Tabs">
        <Tabs defaultValue="design" className="w-full max-w-md">
          <TabsList>
            <TabsTrigger value="design">Design</TabsTrigger>
            <TabsTrigger value="tokens">Tokens</TabsTrigger>
            <TabsTrigger value="motion">Motion</TabsTrigger>
          </TabsList>
          <TabsContent value="design" className="text-sm text-text-secondary">
            shadcn behavior, kept skin.
          </TabsContent>
          <TabsContent value="tokens" className="text-sm text-text-secondary">
            Every color is a CSS variable.
          </TabsContent>
          <TabsContent value="motion" className="text-sm text-text-secondary">
            Calm by default; spend it on the drop.
          </TabsContent>
        </Tabs>
      </Section>

      <Section title="Overlays">
        <Dialog>
          <DialogTrigger asChild>
            <Button variant="secondary">Open dialog</Button>
          </DialogTrigger>
          <DialogContent>
            <DialogHeader>
              <DialogTitle>Keep this page?</DialogTitle>
              <DialogDescription>
                It serves from the edge and stays up.
              </DialogDescription>
            </DialogHeader>
            <DialogFooter>
              <Button variant="ghost">Not now</Button>
              <Button>Keep it</Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>

        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button variant="secondary" size="icon" aria-label="Menu">
              <Settings />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="start">
            <DropdownMenuLabel>Account</DropdownMenuLabel>
            <DropdownMenuItem>Settings</DropdownMenuItem>
            <DropdownMenuItem>Theme</DropdownMenuItem>
            <DropdownMenuSeparator />
            <DropdownMenuItem>Sign out</DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>

        <Popover>
          <PopoverTrigger asChild>
            <Button variant="ghost">Popover</Button>
          </PopoverTrigger>
          <PopoverContent>
            <p className="text-sm text-text-secondary">
              Quiet and disciplined.
            </p>
          </PopoverContent>
        </Popover>

        <Tooltip>
          <TooltipTrigger asChild>
            <Button variant="ghost">Hover me</Button>
          </TooltipTrigger>
          <TooltipContent>kept tooltip</TooltipContent>
        </Tooltip>

        <Button
          variant="secondary"
          onClick={() => toast.success("Page kept", { description: "It stays up." })}
        >
          Toast
        </Button>
      </Section>

      <Section title="Avatar & loading">
        <Avatar>
          <AvatarFallback>KP</AvatarFallback>
        </Avatar>
        <div className="flex flex-1 flex-col gap-2">
          <Skeleton className="h-4 w-40" />
          <Skeleton className="h-4 w-24" />
        </div>
      </Section>
    </div>
  );
}
