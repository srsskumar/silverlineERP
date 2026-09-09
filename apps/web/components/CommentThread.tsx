'use client';

import * as React from 'react';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { listComments, postComment } from '@/lib/tasks';
import { MENTION_HINT_TEXT, commentSchema, type CommentFormInput } from '@/lib/validation';
import { queryKeys } from '@/lib/query-keys';
import { applyFieldErrors } from '@/lib/form-errors';
import { shortUserId } from './ApprovalTimeline';
import { Button } from './ui/Button';
import { EmptyState } from './ui/EmptyState';
import { ErrorCard } from './ui/ErrorCard';
import { Spinner } from './ui/Spinner';

/**
 * Task comment thread. Post with `{body}`; the server extracts @mentions —
 * the response's `mentioned_usernames[]` is shown as a confirmation line.
 */
export function CommentThread({
  taskId,
  canComment = false,
}: {
  taskId: string;
  canComment?: boolean;
}) {
  const queryClient = useQueryClient();
  const [submitError, setSubmitError] = React.useState<unknown>(null);
  const [lastMentioned, setLastMentioned] = React.useState<string[] | null>(null);

  const commentsQuery = useQuery({
    queryKey: queryKeys.taskComments.list(taskId),
    queryFn: () => listComments(taskId),
  });

  const {
    register,
    handleSubmit,
    reset,
    setError,
    formState: { errors },
  } = useForm<CommentFormInput>({
    resolver: zodResolver(commentSchema),
    defaultValues: { body: '' },
  });

  const mutation = useMutation({
    mutationFn: (v: CommentFormInput) => postComment(taskId, v.body.trim()),
    onSuccess: async (result) => {
      setSubmitError(null);
      setLastMentioned(result.mentioned_usernames);
      reset({ body: '' });
      await queryClient.invalidateQueries({ queryKey: queryKeys.taskComments.list(taskId) });
    },
    onError: (err) => {
      const mapped = applyFieldErrors(err, (f, e) => setError(f as keyof CommentFormInput, e));
      if (!mapped) setSubmitError(err);
      else setSubmitError(err);
    },
  });

  return (
    <section aria-label="Comments" className="rounded-lg border border-slate-200 bg-white p-4">
      <h2 className="text-sm font-semibold text-slate-900">Comments</h2>
      {commentsQuery.isLoading ? (
        <div className="flex items-center gap-2 py-6 text-sm text-slate-500">
          <Spinner size="sm" /> Loading comments…
        </div>
      ) : commentsQuery.isError ? (
        <div className="mt-3">
          <ErrorCard title="Could not load comments" error={commentsQuery.error} onRetry={() => commentsQuery.refetch()} />
        </div>
      ) : (commentsQuery.data ?? []).length === 0 ? (
        <div className="mt-3">
          <EmptyState title="No comments yet" description="Start the discussion — decisions and blockers belong here." />
        </div>
      ) : (
        <ul className="mt-3 flex flex-col gap-3">
          {(commentsQuery.data ?? []).map((c) => (
            <li key={c.id} className="rounded-md bg-slate-50 px-3 py-2">
              <p className="text-xs text-slate-500">
                <span className="font-medium text-slate-700">{c.author_username || shortUserId(c.author_user_id)}</span>
                {' · '}
                <span className="font-mono" title={c.author_user_id}>{shortUserId(c.author_user_id)}</span>
                {c.created_at ? ` · ${String(c.created_at)}` : ''}
              </p>
              <p className="mt-1 whitespace-pre-wrap text-sm text-slate-800">{c.body}</p>
            </li>
          ))}
        </ul>
      )}
      {canComment && (
        <form onSubmit={handleSubmit((v) => mutation.mutate(v))} className="mt-4 flex flex-col gap-2" noValidate>
          <label htmlFor={`comment-box-${taskId}`} className="text-sm font-medium text-slate-700">
            Add a comment
          </label>
          <textarea
            id={`comment-box-${taskId}`}
            rows={3}
            className="w-full rounded-md border border-slate-300 bg-white px-3 py-2 text-sm text-slate-900 placeholder:text-slate-400 focus:outline-none focus:ring-2 focus:ring-brand-500 focus:ring-offset-1"
            placeholder="Write an update, question, or decision…"
            {...register('body')}
          />
          {errors.body?.message ? (
            <p role="alert" className="text-xs text-red-600">
              {errors.body.message}
            </p>
          ) : null}
          <p className="text-xs text-slate-500">{MENTION_HINT_TEXT}</p>
          {submitError ? <ErrorCard title="Could not post comment" error={submitError} /> : null}
          {lastMentioned && lastMentioned.length > 0 ? (
            <p role="status" className="text-xs text-green-700">
              Mentioned: {lastMentioned.map((u) => `@${u}`).join(', ')}
            </p>
          ) : null}
          <div>
            <Button type="submit" loading={mutation.isPending}>
              Post comment
            </Button>
          </div>
        </form>
      )}
    </section>
  );
}
