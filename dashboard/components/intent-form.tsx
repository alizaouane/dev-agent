'use client';

import { useState } from 'react';
import { Button } from '@/components/ui/button';
import { Textarea } from '@/components/ui/textarea';
import { Label } from '@/components/ui/label';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import type { RepoInfo } from '@/lib/repos';
import { dropIntent } from '@/lib/actions';

export function IntentForm({ repos }: { repos: RepoInfo[] }) {
  const [intent, setIntent] = useState('');
  const [repo, setRepo] = useState(repos[0] ? `${repos[0].owner}/${repos[0].name}` : '');
  const disabled = intent.trim().length === 0 || repo === '';
  return (
    <form action={dropIntent} className="flex max-w-2xl flex-col gap-4">
      <div className="flex flex-col gap-2">
        <Label htmlFor="repo">Repo</Label>
        <Select name="repo" value={repo} onValueChange={setRepo}>
          <SelectTrigger id="repo">
            <SelectValue placeholder="Select a repo" />
          </SelectTrigger>
          <SelectContent>
            {repos.map((r) => (
              <SelectItem key={`${r.owner}/${r.name}`} value={`${r.owner}/${r.name}`}>
                {r.owner}/{r.name}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <input type="hidden" name="repo" value={repo} />
      </div>
      <div className="flex flex-col gap-2">
        <Label htmlFor="intent">Intent</Label>
        <Textarea
          id="intent"
          name="intent"
          rows={6}
          placeholder="Describe what you want to ship in 1–3 sentences."
          value={intent}
          onChange={(e) => setIntent(e.target.value)}
        />
      </div>
      <div>
        <Button type="submit" disabled={disabled}>
          Drop intent
        </Button>
      </div>
    </form>
  );
}
