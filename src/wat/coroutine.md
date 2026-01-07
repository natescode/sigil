# CO-ROUTINES

Let's go over how a function can be converted into a co-routine.
The main idea is that we need to save the current state (stack) into the heap.
We then need the ability to resume later.
The function gets turned into a state machine.


```silicon
    @fn simple_co = {
        @@yield 1;
        @@yield 2;
        @@yield 3;
    }
```

All the above function does is yield three times.

Here is what this looks like in `WAT`.

1. Allocate memory for the co-routine state.
    1) Status: Running, Paused, Complete
    2) 

```wasm
  ;; ==== COROUTINE FUNCTION ====
  (func $coroutine_fn
    (block $coroutine_start
      ;; First execution step
      (call $yield (i32.const 1)) ;; Save IP = 1
    )
    (block $coroutine_step1
      ;; Second execution step
      (call $yield (i32.const 2)) ;; Save IP = 2
    )
    (block $coroutine_step2
      ;; Final step: Coroutine completes
      (i32.const 2) ;; Set state to COMPLETED
      (global.get $current_coroutine)
      (i32.store offset=8)
    )
  )
```