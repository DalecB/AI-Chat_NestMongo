import { createParamDecorator, ExecutionContext } from '@nestjs/common';

import { UserDocument } from '../../users/schemas/user.schema';

type RequestWithUser = {
  user?: UserDocument;
};

export const CurrentUser = createParamDecorator(
  (_data: unknown, ctx: ExecutionContext): UserDocument => {
    const request = ctx.switchToHttp().getRequest<RequestWithUser>();
    return request.user as UserDocument;
  },
);
