'use client';
import Link from 'next/link';
import { forwardRef,type ComponentProps } from 'react';
import { staticHref } from '@/lib/routes';
export default forwardRef<HTMLAnchorElement,ComponentProps<typeof Link>>(function AppLink({href,...props},ref){return <Link {...props} ref={ref} href={typeof href==='string'?staticHref(href):href}/>;});
