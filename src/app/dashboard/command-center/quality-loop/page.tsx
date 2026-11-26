import { notFound } from 'next/navigation';
import { createClient } from '@/lib/supabase/server';
import { isCommandCenterAdmin } from '@/lib/command-center/access';
import { QualityLoopPanel } from './QualityLoopPanel';
export const dynamic='force-dynamic';
export const metadata={title:'Autonomous Quality Loop',robots:{index:false,follow:false}};
export default async function Page(){const auth=await createClient();const {data:{user},error}=await auth.auth.getUser();if(error||!isCommandCenterAdmin(user))notFound();return <QualityLoopPanel/>;}
