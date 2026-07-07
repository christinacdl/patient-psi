import { kv } from '@/lib/local-kv';
import { NextResponse } from 'next/server';

export async function GET() {
    const user = await kv.hgetall('user:me');
    return NextResponse.json(user);
}