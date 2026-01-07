export const WAT = {
    // This is the temporary version for LOOP
    LOOP: (funcName: string) => `
    ;; Define the function foo
    (func $loop (param $start i32) (param $stop i32)
      (local $index i32)  ;; Loop index
      (local $value i32)  ;; Current value
      
      ;; Initialize $index and $value
      i32.const 0
      local.set $index
  
      local.get $start
      local.set $value
  
      ;; Start loop
      (loop $loop
        ;; Call the passed function with index and value
        local.get $index
        local.get $value
        call \$${funcName}
  
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
  
        ;; Check if value is less than or equal. If so, break
        local.get $value
        local.get $stop
        i32.le_u
        br_if $loop
      )
    )
`,
    RANGE: (start: number, stop: number) => `
    ;; Define the function foo
    (func $range (param $start i32) (param $stop i32)
      (local $index i32)  ;; Loop index
      (local $value i32)  ;; Current value
      
      ;; Initialize $index and $value
      i32.const 0
      local.set $index
  
      local.get $start
      local.set $value
  
      ;; Start loop
      (loop $loop
  
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
  
        ;; Check if value is less than or equal. If so, break
        local.get $value
        local.get $stop
        i32.le_u
        br_if $loop
      )
    )
`,
}