;; A simple bump allocator in WebAssembly
;; This module exports a function malloc that takes a size parameter
;; and returns a pointer to the start of the allocated block
;; The module also exports a function reset that resets the bump pointer
;; back to the start of the heap
(module
  (memory (export "mem") 1)  ;; 64KiB of memory (1 page)
  
  (global $heap_start i32 (i32.const 65536)) ;; Start address (64KiB)
  (global $bump_ptr (mut i32) (global.get $heap_start)) ;; Moving pointer
  
  (func (export "malloc") (param $size i32) (result i32)
    ;; Load the current bump pointer
    (local $ptr i32)
    (local.set $ptr (global.get $bump_ptr))
    
    ;; Calculate new pointer position
    (global.set $bump_ptr (i32.add (global.get $bump_ptr) (local.get $size)))

    ;; Check if the new pointer is within bounds, if not, grow the memory by the aligned size
    (if (i32.gt_u (local.get $ptr) (global.get $heap_start))
      (then
        (local.set $ptr (call $grow_memory (local.get $size)))
      )
    )


    ;; Return the old pointer (start of allocated block)
    (local.get $ptr)
  )
  
  (func (export "reset") 
    ;; Reset the bump pointer back to heap start
    (global.set $bump_ptr (global.get $heap_start))
  )

    (func $grow_memory (param $size i32) (result i32)
        ;; Calculate the new size of the memory
        (local $new_size i32)
        (local.set $new_size (i32.add (i32.add (global.get $heap_start) (global.get $bump_ptr)) (local.get $size)))
    
        ;; Grow the memory by the new size
        (memory.grow (i32.div_s (local.get $new_size) (i32.const 65536)))
    
        ;; Return the new pointer
        (local.get $new_size)
    )

)
