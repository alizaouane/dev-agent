import { minimatch } from 'minimatch';

export type ClassificationInput = {
  changed_files: string[];
  declared_scope: string[];
  trivial_categories: string[];
  trivial_classifier: (path: string) => boolean;
  thresholds: { files_outside_spec_scope: number; loc_outside_spec_scope: number };
  added_lines: Record<string, number>;
};

export type Verdict = 'clean' | 'needs_review' | 'scope_creep';

export type Classification = {
  in_scope: string[];
  trivial: string[];
  out_of_scope: string[];
  loc_out_of_scope: number;
  verdict: Verdict;
};

export function classifyChangedFiles(input: ClassificationInput): Classification {
  const in_scope: string[] = [];
  const trivial: string[] = [];
  const out_of_scope: string[] = [];

  for (const file of input.changed_files) {
    if (input.declared_scope.some((glob) => minimatch(file, glob))) {
      in_scope.push(file);
    } else if (input.trivial_classifier(file)) {
      trivial.push(file);
    } else {
      out_of_scope.push(file);
    }
  }

  const loc_out_of_scope = out_of_scope.reduce(
    (sum, f) => sum + (input.added_lines[f] ?? 0),
    0,
  );

  let verdict: Verdict = 'clean';
  if (out_of_scope.length > 0) {
    if (
      out_of_scope.length > input.thresholds.files_outside_spec_scope ||
      loc_out_of_scope > input.thresholds.loc_outside_spec_scope
    ) {
      verdict = 'scope_creep';
    } else {
      verdict = 'needs_review';
    }
  }

  return { in_scope, trivial, out_of_scope, loc_out_of_scope, verdict };
}
