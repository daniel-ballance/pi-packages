import { lstat, open, realpath } from 'node:fs/promises';
import { constants } from 'node:fs';
import { isAbsolute, relative, resolve, sep } from 'node:path';
import { Type } from '@durable-subagents/pi-ai';
import { defineTool } from '@earendil-works/pi-durable';
/** A bounded readonly native tool. No ambient parent tool/extension inheritance. */
export function childRead(get) {
    return defineTool({ name: 'read', description: 'Read up to 64000 UTF-8 bytes from a regular file inside this child cwd. No writes or shell execution.',
        parameters: Type.Object({ path: Type.String() }, { additionalProperties: false }), replay: 'safe',
        execute: async (args, api, context) => {
            const child = await get().assertToolAllowed(api.conversationId, 'read', context);
            const path = await realpath(resolve(child.cwd, args.path));
            const part = relative(child.cwd, path);
            if (isAbsolute(part) || part === '..' || part.startsWith(`..${sep}`))
                throw new Error('Read path is outside child cwd');
            const before = await lstat(path);
            if (!before.isFile())
                throw new Error('Read requires a regular file');
            const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
            try {
                const info = await file.stat();
                if (info.dev !== before.dev || info.ino !== before.ino || await realpath(path) !== path)
                    throw new Error('Read file changed during admission');
                if (!info.isFile() || info.size > 64000)
                    throw new Error('Read requires a regular file of at most 64000 bytes');
                const buffer = Buffer.alloc(64001);
                const { bytesRead } = await file.read(buffer, 0, buffer.length, 0);
                if (bytesRead > 64000)
                    throw new Error('File exceeds read limit');
                return { content: [{ type: 'text', text: buffer.subarray(0, bytesRead).toString('utf8') }] };
            }
            finally {
                await file.close();
            }
        },
    });
}
