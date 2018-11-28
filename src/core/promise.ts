import {
  constructorError,
  resolverError,
  resolveSelfError,
  cannotReturnOwn
} from '../utils/error';
import { isObjectORFunction, isFunction } from '../utils/is';
import { TRY_CATCH_ERROR, PROMISE_STATUS } from './const';
import asap from './asap';
export interface Thenable<R> {
  then<U>(
    onFulfilled?: (value: R) => U | Thenable<U>,
    onRejected?: (error: any) => U | Thenable<U>
  ): Thenable<U>;
  then<U>(
    onFulfilled?: (value: R) => U | Thenable<U>,
    onRejected?: (error: any) => void
  ): Thenable<U>;
}

export interface Resolve<R> {
  (value?: R | Thenable<R>): void;
}

export interface Reject {
  (error?: any): void;
}

export interface Resolver<R> {
  (resolve: Resolve<R>, reject: Reject): void;
}

type PromiseStatus = 'pending' | 'fulfilled' | 'rejected';
export default class Promise<R> implements Thenable<R> {
  private ['[[PromiseStatus]]']: PromiseStatus = 'pending';
  private ['[[PromiseValue]]']: any = undefined;
  private subscribes: any[] = [];

  constructor(resolver: Resolver<R>) {
    // resolver 必须为函数
    typeof resolver !== 'function' && resolverError();

    // 使用 Promise，需要用 new 操作符
    this instanceof Promise ? this.init(resolver) : constructorError();
  }

  private init(resolver: Resolver<R>) {
    try {
      resolver(
        value => {
          this.mockResolve(value);
        },
        reason => {
          this.mockReject(reason);
        }
      );
    } catch (e) {
      this.mockReject(e);
    }
    return null;
  }
  private isThenable(value: any, then: any) {
    const sameConstructor = value.constructor === this.constructor;
    const sameThen = then === this.then;
    const sameResolve = value.constructor.resolve === Promise.resolve;
    return sameConstructor && sameThen && sameResolve;
  }
  private subscribe(parent, child, onFulfillment, onRejection) {
    let { subscribes } = parent;
    let { length } = subscribes;

    subscribes[length] = child;
    subscribes[length + PROMISE_STATUS.fulfilled] = onFulfillment;
    subscribes[length + PROMISE_STATUS.rejected] = onRejection;

    if (length === 0) {
      asap(this.publish, parent);
    }
  }
  private publish() {
    const subscribes = this.subscribes;
    const state = this['[[PromiseStatus]]'];
    const settled = PROMISE_STATUS[state];
    const result = this['[[PromiseValue]]'];

    if (subscribes.length === 0) {
      return;
    }

    for (let i = 0; i < subscribes.length; i += 3) {
      const item = subscribes[i];
      const callback = subscribes[settled];
      if (item) {
        this.invokeCallback(state, item, callback, result);
      } else {
        callback(result);
      }
    }
  }
  private tryCatch(callback, detail) {
    try {
      return callback(detail);
    } catch (e) {
      TRY_CATCH_ERROR.error = e;
      return TRY_CATCH_ERROR;
    }
  }
  private invokeCallback(settled, child, callback, detail) {
    const hasCallback = isFunction(callback);
    let value, error, succeeded, failed;

    if (hasCallback) {
      value = this.tryCatch(callback, detail);

      if (value === TRY_CATCH_ERROR) {
        failed = true;
        error = value.error;
        value.error = null;
      } else {
        succeeded = true;
      }

      if (this === value) {
        this.mockReject(cannotReturnOwn());
        return;
      }
    } else {
      value = detail;
      succeeded = true;
    }

    if (child['[[PromiseStatus]]'] !== 'pending') {
      return;
    }

    if (hasCallback && succeeded) {
      this.mockResolve(value);
      return;
    }

    if (failed) {
      this.mockReject(error);
      return;
    }

    if (settled === 'fulfilled') {
      this.fulfill(value);
      return;
    }

    if (settled === 'rejected') {
      this.mockReject(value);
      return;
    }
  }
  private handleOwnThenable(thenable: any) {
    const state = thenable['[[PromiseStatus]]'];
    const result = thenable['[[PromiseValue]]'];

    if (state === 'fulfilled') {
      this.fulfill(result);
      return;
    }
    if (state === 'fulfilled') {
      this.mockReject(result);
      return;
    }
    this.subscribe(
      thenable,
      undefined,
      value => this.mockResolve(value),
      reason => this.mockReject(reason)
    );
  }
  private tryThen(then, thenable, onFulfilled, onRejected) {
    try {
      then.call(thenable, onFulfilled, onRejected);
    } catch (e) {
      return e;
    }
  }
  private handleForeignThenable(thenable: any, then: any) {
    asap(() => {
      let sealed = false;
      const error = this.tryThen(
        then,
        thenable,
        value => {
          if (sealed) {
            return;
          }
          sealed = true;
          if (thenable !== value) {
            this.mockResolve(value);
          } else {
            this.fulfill(value);
          }
        },
        reason => {
          if (sealed) {
            return;
          }
          sealed = true;

          this.mockReject(reason);
        }
      );

      if (!sealed && error) {
        sealed = true;
        this.mockReject(error);
      }
    }, this);
  }
  private handleLikeThenable(value: any, then: any) {
    if (this.isThenable(value, then)) {
      this.handleOwnThenable(value);
      return;
    }
    if (then === TRY_CATCH_ERROR) {
      this.mockReject(TRY_CATCH_ERROR.error);
      TRY_CATCH_ERROR.error = null;
      return;
    }
    if (isFunction(then)) {
      this.handleForeignThenable(value, then);
      return;
    }
    this.fulfill(value);
  }
  private fulfill(value: any) {
    this['[[PromiseStatus]]'] = 'fulfilled';
    this['[[PromiseValue]]'] = value;
    if (this.subscribes.length !== 0) {
      asap(this.publish, this);
    }
  }
  private getThen(value: any) {
    try {
      return value.then;
    } catch (error) {
      TRY_CATCH_ERROR.error = error;
      return TRY_CATCH_ERROR;
    }
  }
  private mockResolve(value: any) {
    // resolve 不能传入当前 Promise 实例
    if (value === this) {
      this.mockReject(resolveSelfError);
      return;
    }
    if (!isObjectORFunction(value)) {
      this.fulfill(value);
      return;
    }
    this.handleLikeThenable(value, this.getThen(value));
  }
  private mockReject(reason: any) {}

  then(onFulfilled?, onRejected?) {
    const parent: any = this;
    const child = new parent.constructor(() => {});
    const state = PROMISE_STATUS[this['[[PromiseStatus]]']];
    if (state) {
      const callback = arguments[state - 1];
      asap(() =>
        this.invokeCallback(state, child, callback, this['[[PromiseValue]]'])
      );
    } else {
      this.subscribe(parent, child, onFulfilled, onRejected);
    }
    return child;
  }
  catch(onRejection) {
    return this.then(null, onRejection);
  }
  finally(callback) {
    return this.then(callback, callback);
  }

  static resolve(object) {
    return null;
  }
  static reject(reason) {
    return null;
  }
  static all() {
    return null;
  }
  static race() {
    return null;
  }
}