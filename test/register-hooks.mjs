/** 注册测试用解析钩子（node --import ./test/register-hooks.mjs）。 */

import { register } from 'node:module'

register(new URL('./hooks.mjs', import.meta.url))
