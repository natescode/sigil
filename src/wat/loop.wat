;; WebAssembly text format
;; Example of a simple loop in WebAssembly
;; This module exports a function foo that takes two parameters
;; and prints the index and value of the loop to the console  

(module
  ;; Import print function from JavaScript (expects two i32 parameters)
    (import "env" "print" (func $print (param i32 i32)))

  ;; Define the function foo
  (func $foo (export "foo") (param $start i32) (param $stop i32)
    (local $index i32)  ;; Loop index
    (local $value i32)  ;; Current value
    
    ;; Initialize $index and $value
    i32.const 0
    local.set $index

    local.get $start
    local.set $value

    ;; Start loop
    (loop $loop
      ;; Call print function with index and value
      local.get $index
      local.get $value
      call $print

      ;; Increment value
      local.get $value
      i32.const 1
      i32.add
      local.set $value

      ;; Increment index
      local.get $index
      i32.const 1
      i32.add
      local.set $index

      ;; Check if value is less than or equal to stop
      local.get $value
      local.get $stop
      i32.le_u
      br_if $loop
    )
  )
)


;; JavaScript code to run the WebAssembly module
;; const wasmInstance = new WebAssembly.Instance(wasmModule, {
;;   env: {
;;     print: (index, value) => console.log(`Index: ${index}, Value: ${value}`)
;;   }                                                                                          
;; }
;;                                              );
;; const { foo } = wasmInstance.exports;
;; foo(1,10)