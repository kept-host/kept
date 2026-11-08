"use client";

/**
 * Settings → Profile, below the handle (E10 D12, PRD §4.6): display name,
 * avatar, bio and socials. NO IMPORTED DESIGN (Q10) — built from tokens and the
 * settings cards around it, and flagged for Arun's review.
 *
 * The avatar is the sign-in provider's image when there is one, else initials:
 * avatar uploads are out of scope. Nothing here shows at the edge until E12's
 * wall, so a save writes rows only.
 *
 * One form, one `PATCH /api/profile` with every field: the server validates
 * (bio ≤ 160, socials `https://` on their network's hosts) and its sentence is
 * the one shown. A social left empty is a removed link.
 */
import { useEffect, useId, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";

import { PROFILE_BIO_MAX, PROFILE_DISPLAY_NAME_MAX, SOCIAL_NETWORKS, type ProfileResult, type SocialNetwork } from "@kept/shared";

import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { saveProfile } from "@/lib/sites/owner-client";
import { cn } from "@/lib/utils";

import { SettingsCard } from "./settings-card";

const SOCIAL_LABEL: Record<SocialNetwork, string> = {
  x: "X",
  linkedin: "LinkedIn",
  youtube: "YouTube",
  github: "GitHub",
  instagram: "Instagram",
  tiktok: "TikTok",
  bluesky: "Bluesky",
  website: "Website",
};

/** Up to two initials from a display name, else the email's first letter. */
function initialsOf(name: string, email: string): string {
  const words = name.trim().split(/\s+/).filter(Boolean);
  const letters = words.length > 0 ? words.slice(0, 2).map((word) => word[0]) : [email[0] ?? "?"];
  return letters.join("").toUpperCase();
}

export function ProfileFields({
  profile,
  email,
  image,
}: {
  profile: Pick<ProfileResult, "displayName" | "bio" | "socials">;
  email: string;
  /** The sign-in provider's image, if it gave one. */
  image: string | null;
}) {
  const router = useRouter();
  const [displayName, setDisplayName] = useState(profile.displayName);
  const [bio, setBio] = useState(profile.bio ?? "");
  const [socials, setSocials] = useState<Record<SocialNetwork, string>>(
    () => Object.fromEntries(SOCIAL_NETWORKS.map((n) => [n, profile.socials[n] ?? ""])) as Record<SocialNetwork, string>,
  );
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const request = useRef<AbortController | null>(null);
  const ids = { name: useId(), bio: useId(), bioCount: useId(), error: useId() };

  useEffect(() => () => request.current?.abort(), []);

  const bioLength = [...bio.trim()].length;

  async function save() {
    request.current?.abort();
    const controller = new AbortController();
    request.current = controller;
    setSaving(true);
    setError(null);
    const outcome = await saveProfile(
      {
        displayName,
        bio,
        socials: Object.fromEntries(
          SOCIAL_NETWORKS.filter((n) => socials[n].trim() !== "").map((n) => [n, socials[n].trim()]),
        ),
      },
      controller.signal,
    );
    if (controller.signal.aborted) return;
    setSaving(false);
    if (!outcome.ok) {
      setError(outcome.error.message);
      return;
    }
    const saved = outcome.result;
    setDisplayName(saved.displayName);
    setBio(saved.bio ?? "");
    toast.success("Profile saved.");
    router.refresh();
  }

  return (
    <SettingsCard title="Profile" data-testid="profile-fields">
      <form
        onSubmit={(event) => {
          event.preventDefault();
          void save();
        }}
        noValidate
        aria-describedby={error ? ids.error : undefined}
        className="flex flex-col gap-4"
      >
        <div className="flex items-center gap-3">
          <Avatar className="size-12 border border-border">
            {image ? <AvatarImage src={image} alt="" /> : null}
            <AvatarFallback className="bg-sunken font-display text-base font-bold text-text">
              {initialsOf(displayName, email)}
            </AvatarFallback>
          </Avatar>
          <p className="text-sm leading-relaxed text-text-secondary">
            {image ? "Your picture comes from your sign-in account." : "Your initials stand in for a picture."}
          </p>
        </div>

        <div className="flex flex-col gap-1.5">
          <label htmlFor={ids.name} className="text-sm font-medium text-text">
            Display name
          </label>
          <Input
            id={ids.name}
            name="displayName"
            data-testid="profile-display-name"
            value={displayName}
            maxLength={PROFILE_DISPLAY_NAME_MAX}
            autoComplete="name"
            disabled={saving}
            onChange={(event) => setDisplayName(event.target.value)}
          />
        </div>

        <div className="flex flex-col gap-1.5">
          <label htmlFor={ids.bio} className="text-sm font-medium text-text">
            Bio
          </label>
          <Textarea
            id={ids.bio}
            name="bio"
            data-testid="profile-bio"
            value={bio}
            rows={3}
            disabled={saving}
            aria-describedby={ids.bioCount}
            onChange={(event) => setBio(event.target.value)}
          />
          <span
            id={ids.bioCount}
            className={cn(
              "self-end font-mono text-xs",
              bioLength > PROFILE_BIO_MAX ? "text-danger" : "text-text-secondary",
            )}
          >
            {bioLength} / {PROFILE_BIO_MAX}
          </span>
        </div>

        <fieldset className="flex flex-col gap-2.5">
          <legend className="mb-1 text-sm font-medium text-text">Links</legend>
          {SOCIAL_NETWORKS.map((network) => (
            <label key={network} className="grid grid-cols-[96px_1fr] items-center gap-3">
              <span className="text-sm text-text-secondary">{SOCIAL_LABEL[network]}</span>
              <Input
                name={`social-${network}`}
                data-testid={`profile-social-${network}`}
                type="url"
                inputMode="url"
                placeholder="https://"
                value={socials[network]}
                disabled={saving}
                onChange={(event) => setSocials((current) => ({ ...current, [network]: event.target.value }))}
              />
            </label>
          ))}
        </fieldset>

        <div
          id={ids.error}
          role="alert"
          data-testid="profile-error"
          className={cn("min-h-5 text-[13px] leading-relaxed text-danger", !error && "sr-only")}
        >
          {error}
        </div>

        <Button
          type="submit"
          size="sm"
          data-testid="profile-save"
          disabled={saving}
          className="self-start font-body font-medium"
        >
          {saving ? "Saving…" : "Save profile"}
        </Button>
      </form>
    </SettingsCard>
  );
}
